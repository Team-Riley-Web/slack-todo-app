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

it('exposes exactly the eleven contracted tools', () => {
  expect([...TOOL_NAMES].sort()).toEqual([
    'complete_task', 'create_task', 'create_task_for_context', 'get_space_for_channel',
    'get_task', 'get_task_counts', 'list_spaces', 'list_tasks',
    'list_tasks_for_context', 'list_waiting', 'move_task',
  ]);
  expect(new Set(buildTools(db).map((t) => t.name))).toEqual(new Set(TOOL_NAMES));
});

// Required test 18
it('exposes no tool that can rename a task', () => {
  expect(TOOL_NAMES.some((n) => /title|rename|edit|update/i.test(n))).toBe(false);
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
  expect((await call('list_spaces', {})).spaces).toHaveLength(11);
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

it('creates a task in the channel Space with the title byte-exact', async () => {
  await mapChannel('C_SECURE', '#client-secure-logic', 'Client - Secure Logic');
  const raw = 'update the contact form';
  const r = await call('create_task_for_context', { channel_id: 'C_SECURE', title: raw });
  expect(r.task.title).toBe(raw);
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
  expect(r.task.title).toBe('review pricing');
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
