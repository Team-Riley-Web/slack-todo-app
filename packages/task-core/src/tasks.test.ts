import { it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask, getTask, completeTask, reopenTask, moveTask } from './tasks.js';
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
