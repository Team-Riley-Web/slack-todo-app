import { it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import {
  createTask, getTask, completeTask, reopenTask, moveTask, updateTaskDetails,
} from './tasks.js';
import { InvalidTaskIdError, TaskNotFoundError } from './errors.js';

let db: Db;
let spaceId: string;
const actor = { id: 'U_JOSH', source: 'slack' };

beforeEach(async () => {
  db = await createTestDb();
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM spaces WHERE name = 'Agency / Internal'`
  );
  spaceId = rows[0]!.id;
});
afterEach(async () => { await db.close(); });

const make = (title = 'Call Neil') =>
  createTask(db, { title, spaceId, assigneeId: 'U_JOSH', createdBy: 'U_JOSH' });

// Required test 4
it('persists a task with its exact title', async () => {
  const raw = 'Offer Neil Instagram and Facebook package for $100';
  const created = await make(raw);
  const read = await getTask(db, created.id);
  expect(read!.title).toBe(raw);
  expect(read!.status).toBe('open');
  expect(read!.completed_at).toBeNull();
  expect(read!.list_id).toBeNull(); // spec section 5: status is the source of truth
});

it('records a created event', async () => {
  const t = await make();
  const { rows } = await db.query<{ event: string }>(
    `SELECT event FROM task_events WHERE task_id = $1`, [t.id]
  );
  expect(rows.map((r) => r.event)).toEqual(['created']);
});

it('completes a task and sets completed_at', async () => {
  const t = await make();
  const done = await completeTask(db, t.id, actor);
  expect(done.status).toBe('completed');
  expect(done.completed_at).toBeInstanceOf(Date);
  expect(done.title).toBe(t.title);
});

// Required test 6
it('is idempotent on repeated completion, with no duplicate events', async () => {
  const t = await make();
  const first = await completeTask(db, t.id, actor);
  const second = await completeTask(db, t.id, actor);
  expect(second.status).toBe('completed');
  expect(second.completed_at!.getTime()).toBe(first.completed_at!.getTime());
  const { rows } = await db.query(
    `SELECT 1 FROM task_events WHERE task_id = $1 AND event = 'completed'`, [t.id]
  );
  expect(rows).toHaveLength(1);
});

it('reopens a completed task and clears completed_at', async () => {
  const t = await make();
  await completeTask(db, t.id, actor);
  const back = await reopenTask(db, t.id, actor);
  expect(back.status).toBe('open');
  expect(back.completed_at).toBeNull();
  expect(back.title).toBe(t.title);
});

it('is idempotent on repeated reopen of an already-open task', async () => {
  const t = await make();
  const a = await reopenTask(db, t.id, actor);
  const b = await reopenTask(db, t.id, actor);
  expect(a.status).toBe('open');
  expect(b.status).toBe('open');
  const { rows } = await db.query(
    `SELECT 1 FROM task_events WHERE task_id = $1 AND event = 'reopened'`, [t.id]
  );
  expect(rows).toHaveLength(0); // no transition occurred, so no event
});

// Required test 11
it('preserves waiting state and waiting_on', async () => {
  const t = await make();
  const w = await moveTask(db, t.id, { status: 'waiting', waitingOn: 'Milltown reply' }, actor);
  expect(w.status).toBe('waiting');
  expect(w.waiting_on).toBe('Milltown reply');
  const read = await getTask(db, t.id);
  expect(read!.status).toBe('waiting');
  expect(read!.waiting_on).toBe('Milltown reply');
});

it('allows waiting with no waiting_on', async () => {
  const t = await make();
  const w = await moveTask(db, t.id, { status: 'waiting' }, actor);
  expect(w.status).toBe('waiting');
  expect(w.waiting_on).toBeNull();
});

it('clears waiting_on when leaving the waiting state', async () => {
  const t = await make();
  await moveTask(db, t.id, { status: 'waiting', waitingOn: 'Milltown' }, actor);
  const back = await moveTask(db, t.id, { status: 'open' }, actor);
  expect(back.waiting_on).toBeNull();
});

// Required test 10 partner
it('does not auto-complete a waiting task', async () => {
  const t = await make();
  await moveTask(db, t.id, { status: 'waiting' }, actor);
  expect((await getTask(db, t.id))!.status).toBe('waiting');
  const done = await completeTask(db, t.id, actor);
  expect(done.status).toBe('completed');
});

// Required test 17
it('rejects a malformed task id before touching the database', async () => {
  for (const bad of ['', 'not-a-uuid', '../../etc/passwd', "'; DROP TABLE tasks; --", '123']) {
    await expect(getTask(db, bad)).rejects.toThrow(InvalidTaskIdError);
    await expect(completeTask(db, bad, actor)).rejects.toThrow(InvalidTaskIdError);
  }
});

it('throws TaskNotFoundError for a well-formed unknown id', async () => {
  await expect(
    completeTask(db, '00000000-0000-4000-8000-000000000000', actor)
  ).rejects.toThrow(TaskNotFoundError);
});

// Required test 18
it('exposes no title-mutating function', async () => {
  const mod = await import('./index.js');
  const names = Object.keys(mod);
  expect(names.some((n) => /title|rename/i.test(n))).toBe(false);
  for (const n of ['updateTitle', 'renameTask', 'setTitle', 'editTitle']) {
    expect(mod).not.toHaveProperty(n);
  }
});

// Required test 15
it('ignores any title field supplied to a mutation', async () => {
  const t = await make('Original exact title');
  await moveTask(
    db, t.id,
    { status: 'waiting', title: 'AI-rewritten title' } as never,
    actor
  );
  expect((await getTask(db, t.id))!.title).toBe('Original exact title');
});

// --- details column, approved 2026-09-09 ---

it('stores details verbatim, including the long multi-line Workast form', async () => {
  const details = [
    'Workstream: Client onboarding automation',
    'Next actor: Joshua',
    'When: none',
    '',
    'Scope:',
    '• Identify the authoritative form/completion signal.',
    '',
    'Boundary: Do not activate a production workflow without approval.',
  ].join('\n');
  const t = await createTask(db, {
    title: 'Automate onboarding AI primer after client form completion',
    spaceId, details,
  });
  expect(t.details).toBe(details);
  expect((await getTask(db, t.id))!.details).toBe(details);
});

it('accepts a details field far longer than any Slack limit', async () => {
  const details = 'x'.repeat(3224); // longest in the Workast export
  const t = await createTask(db, { title: 'Long details', spaceId, details });
  expect((await getTask(db, t.id))!.details).toHaveLength(3224);
});

it('defaults details to null and never invents content', async () => {
  const t = await createTask(db, { title: 'No details', spaceId });
  expect(t.details).toBeNull();
});

it('ignores a details field smuggled into a move', async () => {
  const t = await createTask(db, { title: 'X', spaceId, details: 'original' });
  await moveTask(db, t.id, { status: 'waiting', details: 'rewritten' } as never, actor);
  expect((await getTask(db, t.id))!.details).toBe('original');
});

// Regression: ISSUE-002 — an unparseable due_at reached Postgres as an Invalid
// Date and surfaced as a 500 instead of a validation error.
// Found by /qa on 2026-09-09
// Report: .gstack/qa-reports/qa-report-team-riley-tasks-2026-09-09.md
it('rejects an unparseable due date before touching the database', async () => {
  const { InvalidDueDateError } = await import('./errors.js');
  for (const bad of ['not-a-date', '', '2026-13-45', 'tomorrow']) {
    await expect(
      createTask(db, { title: 'X', spaceId, dueAt: new Date(bad) })
    ).rejects.toThrow(InvalidDueDateError);
  }
  const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks`);
  expect(rows[0]!.n).toBe(0);
});

it('still accepts a valid due date and a null one', async () => {
  const withDue = await createTask(db, {
    title: 'A', spaceId, dueAt: new Date('2026-09-15T05:00:00Z'),
  });
  expect(withDue.due_at).toBeInstanceOf(Date);
  const without = await createTask(db, { title: 'B', spaceId, dueAt: null });
  expect(without.due_at).toBeNull();
});

// Regression: ISSUE-008 — moveTask stamped completed_at from the app clock
// while completeTask used the database clock, so the two paths could disagree.
// Found by /qa on 2026-09-09
// Report: .gstack/qa-reports/qa-report-team-riley-tasks-2026-09-09.md
it('stamps completed_at from the database clock on both completion paths', async () => {
  const viaComplete = await completeTask(db, (await make('A')).id, actor);
  const viaMove = await moveTask(db, (await make('B')).id, { status: 'completed' }, actor);

  const { rows } = await db.query<{ now: Date }>(`SELECT now() AS now`);
  const dbNow = new Date(rows[0]!.now).getTime();
  for (const t of [viaComplete, viaMove]) {
    expect(t.completed_at).toBeInstanceOf(Date);
    expect(Math.abs(t.completed_at!.getTime() - dbNow)).toBeLessThan(60_000);
  }
});

it('preserves the original completed_at when moving an already-completed task', async () => {
  const t = await make('C');
  const done = await completeTask(db, t.id, actor);
  const moved = await moveTask(db, t.id, { status: 'completed' }, actor);
  expect(moved.completed_at!.getTime()).toBe(done.completed_at!.getTime());
});

// --- details is updatable; title is not ---

it('updates details and records an audit event', async () => {
  const t = await createTask(db, { title: 'X', spaceId, details: 'first' });
  const updated = await updateTaskDetails(db, t.id, 'second', actor);
  expect(updated.details).toBe('second');
  expect((await getTask(db, t.id))!.details).toBe('second');
  const { rows } = await db.query<{ event: string }>(
    `SELECT event FROM task_events WHERE task_id = $1 AND event = 'details'`, [t.id]
  );
  expect(rows).toHaveLength(1);
});

it('clears details with null or an empty string', async () => {
  const t = await createTask(db, { title: 'X', spaceId, details: 'notes' });
  expect((await updateTaskDetails(db, t.id, null, actor)).details).toBeNull();
  await updateTaskDetails(db, t.id, 'again', actor);
  expect((await updateTaskDetails(db, t.id, '', actor)).details).toBeNull();
});

it('adds details to a task created without any', async () => {
  const t = await createTask(db, { title: 'X', spaceId });
  expect((await updateTaskDetails(db, t.id, 'added later', actor)).details).toBe('added later');
});

it('logs no event when details are unchanged', async () => {
  const t = await createTask(db, { title: 'X', spaceId, details: 'same' });
  await updateTaskDetails(db, t.id, 'same', actor);
  const { rows } = await db.query(
    `SELECT 1 FROM task_events WHERE task_id = $1 AND event = 'details'`, [t.id]
  );
  expect(rows).toHaveLength(0);
});

it('cannot touch the title, the space, or the status', async () => {
  const t = await createTask(db, { title: 'Exact original title', spaceId, details: 'a' });
  await moveTask(db, t.id, { status: 'waiting', waitingOn: 'Neil' }, actor);
  const after = await updateTaskDetails(db, t.id, 'b', actor);
  expect(after.title).toBe('Exact original title');
  expect(after.space_id).toBe(spaceId);
  expect(after.status).toBe('waiting');
  expect(after.waiting_on).toBe('Neil');
});

it('rejects a malformed id and a non-string details value', async () => {
  const t = await createTask(db, { title: 'X', spaceId });
  await expect(updateTaskDetails(db, 'not-a-uuid', 'x', actor)).rejects.toThrow(InvalidTaskIdError);
  await expect(updateTaskDetails(db, t.id, 42 as never, actor)).rejects.toThrow();
});

it('still exposes no title-mutating function after adding the details path', async () => {
  const mod = await import('./index.js');
  expect(Object.keys(mod).some((n) => /title|rename/i.test(n))).toBe(false);
});
