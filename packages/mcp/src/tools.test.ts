import { it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { buildTools, TOOL_NAMES } from './tools.js';

let db: Db;
let tools: Map<string, (a: Record<string, unknown>) => Promise<any>>;
let spaceId: string;

beforeEach(async () => {
  db = await createTestDb();
  tools = new Map(buildTools(db).map((t) => [t.name, t.handler]));
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM spaces WHERE name = 'Client - Nazareth Law'`
  );
  spaceId = rows[0]!.id;
});
afterEach(async () => { await db.close(); });

const call = (name: string, args: Record<string, unknown> = {}) => tools.get(name)!(args);

it('exposes exactly the contracted tools', () => {
  expect([...TOOL_NAMES].sort()).toEqual([
    'complete_task', 'create_task', 'create_task_for_context', 'create_tasks',
    'get_completed_between', 'get_import_batch', 'get_import_conflicts',
    'get_open_counts_by_space', 'get_space_for_channel', 'get_task',
    'get_task_counts', 'get_task_health', 'get_this_week',
    'list_import_batches', 'list_spaces', 'list_tasks',
    'list_tasks_for_context', 'list_waiting', 'move_task', 'preview_import',
    'set_task_details',
  ]);
  expect(new Set(buildTools(db).map((t) => t.name))).toEqual(new Set(TOOL_NAMES));
});

// Required test 18
it('exposes no tool that can rename a task', () => {
  expect(TOOL_NAMES.some((n) => /title|rename/i.test(n))).toBe(false);
  // set_task_details is the only write tool beyond create/complete/move, and it
  // reads only task_id and details.
  expect(TOOL_NAMES.filter((n) => n.startsWith('set_'))).toEqual(['set_task_details']);
});

// Required test 14
it('returns exact titles', async () => {
  const raw = 'Offer Neil Instagram and Facebook package for $100';
  await call('create_task', { title: raw, space_id: spaceId });
  expect((await call('list_tasks', {})).tasks[0].title).toBe(raw);
});

// Required test 15
it('ignores a title passed to move_task', async () => {
  const { task } = await call('create_task', { title: 'Original exact title', space_id: spaceId });
  await call('move_task', { task_id: task.id, status: 'waiting', title: 'AI-rewritten' });
  const { task: read } = await call('get_task', { task_id: task.id });
  expect(read.title).toBe('Original exact title');
  expect(read.status).toBe('waiting');
});

it('rejects create_task with a missing or non-string title', async () => {
  await expect(call('create_task', { space_id: spaceId })).rejects.toThrow();
  await expect(call('create_task', { title: 42, space_id: spaceId })).rejects.toThrow();
  await expect(call('create_task', { title: 'X' })).rejects.toThrow();
});

// Required test 17
it('rejects a malformed task id', async () => {
  await expect(call('complete_task', { task_id: 'not-a-uuid' })).rejects.toThrow();
  await expect(call('get_task', { task_id: '../../etc/passwd' })).rejects.toThrow();
});

it('completes idempotently', async () => {
  const { task } = await call('create_task', { title: 'Call Neil', space_id: spaceId });
  const a = await call('complete_task', { task_id: task.id });
  const b = await call('complete_task', { task_id: task.id });
  expect(a.task.completed_at).toEqual(b.task.completed_at);
});

it('records hermes as the source platform on tasks it creates', async () => {
  const { task } = await call('create_task', { title: 'From Hermes', space_id: spaceId });
  expect(task.source_platform).toBe('hermes');
});

it('reports counts and waiting separately from actionable tasks', async () => {
  const { task } = await call('create_task', { title: 'W', space_id: spaceId });
  await call('move_task', { task_id: task.id, status: 'waiting', waiting_on: 'Neil' });
  expect((await call('list_tasks', { actionable_only: true })).tasks).toHaveLength(0);
  expect((await call('list_waiting', {})).tasks[0].waiting_on).toBe('Neil');
  expect((await call('get_task_counts', {})).counts[0].waiting).toBe(1);
});

it('lists all spaces', async () => {
  expect((await call('list_spaces', {})).spaces).toHaveLength(12);
});

it('states the verbatim-title rule in the create_task description', () => {
  const create = buildTools(db).find((t) => t.name === 'create_task')!;
  expect(create.description.toLowerCase()).toContain('verbatim');
  expect(create.description.toLowerCase()).toContain('never be changed');
});

// --- Phase 2: channel-aware context tools ---

const mapChannel = (channelId: string, name: string, space: string) =>
  db.query(
    `INSERT INTO channel_space_map (slack_channel_id, slack_channel_name, space_id)
     SELECT $1, $2, id FROM spaces WHERE name = $3`,
    [channelId, name, space]
  );

it('resolves a Slack channel to its canonical Space without exposing IDs to Hermes', async () => {
  await mapChannel('C_SECURE', '#client-secure-logic', 'Client - Secure Logic');
  const r = await call('get_space_for_channel', { channel_id: 'C_SECURE' });
  expect(r.space.name).toBe('Client - Secure Logic');
  expect(r.mapped).toBe(true);
  expect(r.channel_name).toBe('#client-secure-logic');
});

it('reports an unmapped channel as unmapped and hands back Inbox', async () => {
  const r = await call('get_space_for_channel', { channel_id: 'C_NOPE' });
  expect(r.mapped).toBe(false);
  expect(r.space.name).toBe('Inbox');
});

it('lists tasks for a channel context with no Space ID supplied', async () => {
  await mapChannel('C_SECURE', '#client-secure-logic', 'Client - Secure Logic');
  await call('create_task_for_context', {
    channel_id: 'C_SECURE', title: 'Give Rachael access to Marty photos',
  });
  await call('create_task', { title: 'Elsewhere', space_id: spaceId });

  const r = await call('list_tasks_for_context', { channel_id: 'C_SECURE' });
  expect(r.space.name).toBe('Client - Secure Logic');
  expect(r.resolved_from).toBe('channel');
  expect(r.tasks.map((t: { title: string }) => t.title))
    .toEqual(['Give Rachael access to Marty photos']);
});

/**
 * The guarantee that matters here is that Hermes cannot REWRITE what you wrote.
 * Since 2026-09-11 a lowercase opening letter is capitalised by task-core on
 * every surface; the rest of the string still reaches storage untouched, and
 * MCP still has no way to reach the title of an EXISTING task.
 */
it('creates a task in the channel Space with the title otherwise byte-exact', async () => {
  await mapChannel('C_SECURE', '#client-secure-logic', 'Client - Secure Logic');
  const raw = 'update the contact form';
  const r = await call('create_task_for_context', { channel_id: 'C_SECURE', title: raw });
  expect(r.task.title).toBe('Update the contact form');
  expect(r.task.title.slice(1)).toBe(raw.slice(1));
  expect(r.space.name).toBe('Client - Secure Logic');
  expect(r.resolved_from).toBe('channel');
  expect(r.task.source_channel_id).toBe('C_SECURE');
});

it('lets an explicit destination beat the channel mapping', async () => {
  await mapChannel('C_SECURE', '#client-secure-logic', 'Client - Secure Logic');
  const r = await call('create_task_for_context', {
    channel_id: 'C_SECURE', title: 'review pricing', space: 'Agency / Internal',
  });
  expect(r.space.name).toBe('Agency / Internal');
  expect(r.resolved_from).toBe('explicit');
  expect(r.task.title).toBe('Review pricing');
});

it('rejects an unrecognised explicit destination instead of using the channel Space', async () => {
  await mapChannel('C_SECURE', '#client-secure-logic', 'Client - Secure Logic');
  await expect(call('create_task_for_context', {
    channel_id: 'C_SECURE', title: 'X', space: 'Some Other Client',
  })).rejects.toThrow(/Unknown space/);

  // Nothing may have been created anywhere.
  expect((await call('list_tasks', {})).tasks).toHaveLength(0);
});

it('routes an unmapped channel to Inbox and says so, without guessing', async () => {
  const r = await call('create_task_for_context', {
    channel_id: 'C_client_secure_logic', title: 'Buy a new vehicle',
  });
  expect(r.space.name).toBe('Inbox');
  expect(r.resolved_from).toBe('inbox');
});

it('excludes waiting and completed from a context listing by default', async () => {
  await mapChannel('C_SECURE', '#client-secure-logic', 'Client - Secure Logic');
  const a = await call('create_task_for_context', { channel_id: 'C_SECURE', title: 'Open one' });
  const b = await call('create_task_for_context', { channel_id: 'C_SECURE', title: 'Waiting one' });
  const c = await call('create_task_for_context', { channel_id: 'C_SECURE', title: 'Done one' });
  await call('move_task', { task_id: b.task.id, status: 'waiting' });
  await call('complete_task', { task_id: c.task.id });

  const bare = await call('list_tasks_for_context', { channel_id: 'C_SECURE' });
  expect(bare.tasks.map((t: { title: string }) => t.title)).toEqual(['Open one']);

  const withWaiting = await call('list_tasks_for_context', {
    channel_id: 'C_SECURE', include_waiting: true,
  });
  expect(withWaiting.tasks.map((t: { title: string }) => t.title).sort())
    .toEqual(['Open one', 'Waiting one']);

  const done = await call('list_tasks_for_context', {
    channel_id: 'C_SECURE', status: 'completed',
  });
  expect(done.tasks.map((t: { title: string }) => t.title)).toEqual(['Done one']);
  expect(a.task.title).toBe('Open one');
});

it('carries the verbatim-title instruction on the context creator too', () => {
  const t = buildTools(db).find((x) => x.name === 'create_task_for_context')!;
  expect(t.description.toLowerCase()).toContain('verbatim');
  expect(t.description.toLowerCase()).toContain('exactly as given');
});

it('exposes no context tool that can rename a task', () => {
  const contextTools = TOOL_NAMES.filter((n) => n.endsWith('_for_context'));
  expect(contextTools).toEqual(['list_tasks_for_context', 'create_task_for_context']);
});

// --- details column and approved Space decisions, 2026-09-09 ---

it('stores details verbatim from Hermes', async () => {
  const details = 'Workstream: onboarding\nNext actor: Joshua';
  const { task } = await call('create_task', { title: 'X', space_id: spaceId, details });
  expect(task.details).toBe(details);
  expect((await call('get_task', { task_id: task.id })).task.details).toBe(details);
});

it('accepts details on the context creator', async () => {
  await mapChannel('C_SECURE', '#client-secure-logic', 'Client - Secure Logic');
  const r = await call('create_task_for_context', {
    channel_id: 'C_SECURE', title: 'X', details: 'notes',
  });
  expect(r.task.details).toBe('notes');
});

it('resolves Music as a Space and Personal tasks as an alias', async () => {
  const music = await call('create_task_for_context', {
    channel_id: 'C_NONE', title: 'Prepare for YFF', space: 'Music',
  });
  expect(music.space.name).toBe('Music');

  const personal = await call('create_task_for_context', {
    channel_id: 'C_NONE', title: 'Buy a new vehicle', space: 'Personal tasks',
  });
  expect(personal.space.name).toBe('Personal');
  expect(personal.resolved_from).toBe('explicit');
});

it('marks details write-once in its tool schema', () => {
  const t = buildTools(db).find((x) => x.name === 'create_task')!;
  const details = (t.inputSchema as any).properties.details.description as string;
  expect(details.toLowerCase()).toContain('write-once');
});

// --- set_task_details ---

it('exposes set_task_details and it cannot change the title', async () => {
  const { task } = await call('create_task', {
    title: 'Exact original title', space_id: spaceId, details: 'a',
  });
  const r = await call('set_task_details', {
    task_id: task.id, details: 'b', title: 'AI-REWRITTEN',
  });
  expect(r.task.details).toBe('b');
  expect(r.task.title).toBe('Exact original title');
});

it('clears details via null through MCP', async () => {
  const { task } = await call('create_task', { title: 'X', space_id: spaceId, details: 'a' });
  expect((await call('set_task_details', { task_id: task.id, details: null })).task.details)
    .toBeNull();
});

it('states in its description that it cannot change the title', () => {
  const t = buildTools(db).find((x) => x.name === 'set_task_details')!;
  expect(t.description.toLowerCase()).toContain('cannot change the title');
});

// --- Phase 2A: import inspection and reporting, all read-only ---

it('exposes the twenty-one contracted tools', () => {
  expect(TOOL_NAMES).toHaveLength(21);
  expect(new Set(buildTools(db).map((t) => t.name))).toEqual(new Set(TOOL_NAMES));
});

it('exposes no tool that can confirm, import, roll back, or delete', async () => {
  for (const name of TOOL_NAMES) {
    expect(name).not.toMatch(/confirm|rollback|roll_back|delete|purge|merge/i);
  }
  // And the only write-shaped names are the ones we intend.
  const writes = TOOL_NAMES.filter((n) => /^(create|complete|move|set)_/.test(n));
  expect(writes.sort()).toEqual([
    'complete_task', 'create_task', 'create_task_for_context', 'create_tasks',
    'move_task', 'set_task_details',
  ]);
});

it('leaves a confirmed batch untouched no matter which import tool runs', async () => {
  // Seed a CONFIRMED batch, then call every import-facing tool and assert
  // nothing got written.
  const { rows: b } = await db.query<{ id: string }>(
    `INSERT INTO import_batches (source_type, state, row_count)
     VALUES ('csv', 'CONFIRMED', 1) RETURNING id`
  );
  const batchId = b[0]!.id;
  await db.query(
    `INSERT INTO import_staging (batch_id, row_number, source_type, title, verdict)
     VALUES ($1, 1, 'csv', 'Would be imported', 'READY')`, [batchId]
  );

  await call('list_import_batches', {});
  await call('get_import_batch', { batch_id: batchId });
  await call('preview_import', { batch_id: batchId });
  await call('get_import_conflicts', { batch_id: batchId });

  const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks`);
  expect(rows[0]!.n).toBe(0);
  const { rows: state } = await db.query<{ state: string }>(
    `SELECT state FROM import_batches WHERE id = $1`, [batchId]
  );
  expect(state[0]!.state).toBe('CONFIRMED'); // never advanced
});

it('preview_import takes a batch id and cannot be handed a file', () => {
  const tool = buildTools(db).find((t) => t.name === 'preview_import')!;
  const props = (tool.inputSchema as any).properties;
  expect(Object.keys(props).sort()).toEqual(['batch_id', 'verdict']);
  expect(props.file).toBeUndefined();
  expect(props.content).toBeUndefined();
  expect(tool.description).toMatch(/NOT a file/);
});

it('reports conflicts with their reasons', async () => {
  const { rows: b } = await db.query<{ id: string }>(
    `INSERT INTO import_batches (source_type, state) VALUES ('csv','ANALYZED') RETURNING id`
  );
  const batchId = b[0]!.id;
  await db.query(
    `INSERT INTO import_staging (batch_id, row_number, source_type, title, verdict, reason)
     VALUES ($1, 1, 'csv', 'Dup', 'NEEDS_REVIEW', 'exact title already exists'),
            ($1, 2, 'csv', '', 'INVALID', 'title is empty'),
            ($1, 3, 'csv', 'Fine', 'READY', null)`, [batchId]
  );
  const r = await call('get_import_conflicts', { batch_id: batchId });
  expect(r.conflicts).toHaveLength(2);
  expect(r.conflicts.map((c: any) => c.reason)).toContain('title is empty');
});

it('reports open counts, this week, and task health', async () => {
  const { task } = await call('create_task', { title: 'Open one', space_id: spaceId });
  const { task: done } = await call('create_task', { title: 'Done one', space_id: spaceId });
  await call('complete_task', { task_id: done.id });

  expect((await call('get_open_counts_by_space', {})).counts[0].open).toBe(1);

  const week = await call('get_this_week', {});
  expect(week.created).toHaveLength(2);
  expect(week.completed.map((t: any) => t.title)).toEqual(['Done one']);

  const health = await call('get_task_health', { stale_after_days: 30 });
  expect(health.average_age_days).not.toBeNull();
  expect(health.stale).toHaveLength(0); // created just now
  expect(task.title).toBe('Open one');
});

it('uses a half-open range for completed_between', async () => {
  const { task } = await call('create_task', { title: 'T', space_id: spaceId });
  await call('complete_task', { task_id: task.id });
  await db.query(`UPDATE tasks SET completed_at = '2026-06-15T12:00:00Z' WHERE id = $1`, [
    task.id,
  ]);
  const inside = await call('get_completed_between', {
    from: '2026-06-15T12:00:00Z', to: '2026-06-16T00:00:00Z',
  });
  expect(inside.tasks).toHaveLength(1);
  const outside = await call('get_completed_between', {
    from: '2026-06-01T00:00:00Z', to: '2026-06-15T12:00:00Z',
  });
  expect(outside.tasks).toHaveLength(0);
});

// --- priority, 2026-09-11 ---

it('exposes priority on every task it returns', async () => {
  const { task } = await call('create_task', {
    title: 'Fix Stripe checkout', space_id: spaceId, priority: 'P0',
  });
  expect((task as any).priority).toBe('P0');

  const fetched = await call('get_task', { task_id: (task as any).id });
  expect((fetched as any).task.priority).toBe('P0');

  const listed = await call('list_tasks', {});
  expect((listed as any).tasks[0].priority).toBe('P0');
});

it('leaves priority null when none is given, so an existing caller is unaffected', async () => {
  const { task } = await call('create_task', { title: 'No priority', space_id: spaceId });
  expect((task as any).priority).toBeNull();
});

it('accepts priority on create_task_for_context alongside channel routing', async () => {
  await mapChannel('C_SECURE', '#client-secure-logic', 'Client - Secure Logic');
  const r = await call('create_task_for_context', {
    channel_id: 'C_SECURE', title: 'Urgent client fix', priority: 'P1',
  });
  expect((r as any).task.priority).toBe('P1');
  expect((r as any).resolved_from).toBe('channel');
});

it('rejects an invalid priority rather than storing it as unprioritized', async () => {
  // Dropping P7 to null would make a mistyped priority indistinguishable from
  // a task nobody prioritised, which is the failure this guards.
  await expect(call('create_task', {
    title: 'Bad', space_id: spaceId, priority: 'P7',
  })).rejects.toThrow(/priority/i);
});

it('returns tasks in priority order, the same order every other surface uses', async () => {
  for (const [title, priority] of [
    ['None', undefined], ['Low', 'P3'], ['Critical', 'P0'], ['High', 'P1'],
  ] as const) {
    await call('create_task', { title, space_id: spaceId, ...(priority ? { priority } : {}) });
  }
  const { tasks } = await call('list_tasks', { status: 'open' }) as any;
  expect(tasks.map((t: any) => t.title))
    .toEqual(['Critical', 'High', 'Low', 'None']);
});

it('still exposes no way to change an existing task’s priority or title', () => {
  // Priority is settable at CREATION only, exactly like the title. Adding a
  // priority field must not have opened a general edit path for Hermes.
  expect([...TOOL_NAMES].some(
    (n) => /edit|rename|update_task|set_title|set_priority/i.test(n)
  )).toBe(false);
});

// --- create_tasks: one approval for a whole list ---

it('creates a batch across Spaces with titles otherwise byte-exact', async () => {
  const r = await call('create_tasks', {
    tasks: [
      { title: 'Offer Neil Instagram and Facebook package for $100', space: 'Nazareth Law', priority: 'P1' },
      { title: 'review pricing', space: 'Agency / Internal' },
      { title: 'Call the bank', space_id: spaceId },
    ],
  });
  expect(r.tasks).toHaveLength(3);
  expect(r.tasks[0].task.title).toBe('Offer Neil Instagram and Facebook package for $100');
  expect(r.tasks[0].task.priority).toBe('P1');
  expect(r.tasks[0].space.name).toBe('Client - Nazareth Law');
  expect(r.tasks[1].task.title).toBe('Review pricing');
  expect(r.tasks[1].space.name).toBe('Agency / Internal');
  expect(r.tasks[2].task.priority).toBeNull();
  expect((await call('list_tasks', {})).tasks).toHaveLength(3);
});

it('creates nothing when one task names an unknown Space', async () => {
  await expect(call('create_tasks', {
    tasks: [
      { title: 'Good one', space: 'Agency / Internal' },
      { title: 'Bad one', space: 'Some Other Client' },
    ],
  })).rejects.toThrow(/tasks\[1\].*Unknown space.*nothing was created/s);
  expect((await call('list_tasks', {})).tasks).toHaveLength(0);
});

it('creates nothing when one task has an invalid priority', async () => {
  await expect(call('create_tasks', {
    tasks: [
      { title: 'Good one', space: 'Agency / Internal' },
      { title: 'Bad one', space: 'Agency / Internal', priority: 'P7' },
    ],
  })).rejects.toThrow(/tasks\[1\]/);
  expect((await call('list_tasks', {})).tasks).toHaveLength(0);
});

it('refuses a task with no Space instead of guessing Inbox', async () => {
  await expect(call('create_tasks', { tasks: [{ title: 'Floating' }] }))
    .rejects.toThrow(/tasks\[0\].*space/);
  expect((await call('list_tasks', {})).tasks).toHaveLength(0);
});

it('rejects an unknown space_id and an empty or oversized batch', async () => {
  await expect(call('create_tasks', {
    tasks: [{ title: 'X', space_id: '00000000-0000-0000-0000-000000000000' }],
  })).rejects.toThrow(/Unknown space_id/);
  await expect(call('create_tasks', { tasks: [] })).rejects.toThrow(/non-empty/);
  await expect(call('create_tasks', {
    tasks: Array.from({ length: 26 }, (_, i) => ({ title: `T${i}`, space_id: spaceId })),
  })).rejects.toThrow(/at most 25/);
  expect((await call('list_tasks', {})).tasks).toHaveLength(0);
});

it('tells the assistant to wait for approval and keep titles verbatim', () => {
  const t = buildTools(db).find((x) => x.name === 'create_tasks')!;
  expect(t.description).toMatch(/after the user has seen the complete proposed list/);
  expect(t.description).toMatch(/verbatim/);
});

// --- due_at with no zone is Chicago time, not UTC ---

it('reads a date-only due_at as that day in Chicago, on every create tool', async () => {
  // new Date('2026-10-14') was midnight UTC: 7pm on Oct 13 in Chicago, so a
  // task Claude filed for "Wednesday" showed up as due Tuesday.
  const one = await call('create_task', { title: 'A', space_id: spaceId, due_at: '2026-10-14' });
  const ctx = await call('create_task_for_context', { title: 'B', due_at: '2026-10-14' });
  const batch = await call('create_tasks', {
    tasks: [{ title: 'C', space_id: spaceId, due_at: '2026-10-14T09:00' }],
  });
  expect(new Date(one.task.due_at).toISOString()).toBe('2026-10-14T05:00:00.000Z');
  expect(new Date(ctx.task.due_at).toISOString()).toBe('2026-10-14T05:00:00.000Z');
  expect(new Date(batch.tasks[0].task.due_at).toISOString()).toBe('2026-10-14T14:00:00.000Z');
});

it('keeps an explicit Z or offset exactly as sent', async () => {
  const r = await call('create_task', {
    title: 'Exact', space_id: spaceId, due_at: '2026-10-14T09:00:00Z',
  });
  expect(new Date(r.task.due_at).toISOString()).toBe('2026-10-14T09:00:00.000Z');
});

it('tells the model how a due_at with no zone is read', () => {
  for (const name of ['create_task', 'create_task_for_context', 'create_tasks']) {
    const schema = JSON.stringify(buildTools(db).find((t) => t.name === name)!.inputSchema);
    expect(schema).toContain('America/Chicago');
  }
});
