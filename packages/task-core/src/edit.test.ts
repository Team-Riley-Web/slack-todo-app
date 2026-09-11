import { it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask, getTask, completeTask, moveTask, editTask } from './tasks.js';
import { capitalizeFirstLetter } from './capitalize.js';
import { InvalidTaskIdError, InvalidDueDateError } from './errors.js';

let db: Db;
let spaceId: string;
let otherSpaceId: string;
const actor = { id: 'U_JOSH', source: 'slack' };

beforeEach(async () => {
  db = await createTestDb();
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM spaces WHERE name IN ('Marketing','Sales') ORDER BY name`
  );
  spaceId = rows[0]!.id;       // Marketing
  otherSpaceId = rows[1]!.id;  // Sales
});
afterEach(async () => { await db.close(); });

const make = (over: Record<string, unknown> = {}) =>
  createTask(db, { title: 'Call Neil', spaceId, ...over } as never);

const events = async (taskId: string, event: string) => {
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM task_events WHERE task_id=$1 AND event=$2`,
    [taskId, event]
  );
  return rows[0]!.n;
};

/**
 * Narrowed 2026-09-11, deliberately. A lowercase opening letter is now
 * capitalised at both write paths; EVERY other byte is still written exactly as
 * typed, which is what this guard has always really been protecting -- markdown
 * characters, curly apostrophes, em dashes and emoji surviving the round trip.
 */
it('writes a new title byte-exact apart from the opening letter', async () => {
  const t = await make();
  for (const title of [
    'Offer Neil Instagram and Facebook package for $100',
    'Waiting on Milltown’s reply to the email proposal',
    'Secure Logic — three-month honeymoon check-in with Marty',
    'fix *urgent* bug_now~ish~ `code`',
    'ship it 🚀',
  ]) {
    const expected = capitalizeFirstLetter(title);
    const edited = await editTask(db, t.id, { title }, actor);
    expect(edited.title).toBe(expected);
    expect((await getTask(db, t.id))!.title).toBe(expected);
    // Nothing after the first character was touched.
    expect(edited.title.slice(1)).toBe(title.slice(1));
  }
});

it('leaves a deliberately lowercase opening word alone on edit', async () => {
  // Someone correcting "IPhone" back to "iPhone" must not have it undone.
  const t = await make();
  const edited = await editTask(db, t.id, { title: 'iPhone screen repair' }, actor);
  expect(edited.title).toBe('iPhone screen repair');
});

it('trims only outer whitespace, the single permitted normalization', async () => {
  const t = await make();
  expect((await editTask(db, t.id, { title: '  Call Neil Jr.  ' }, actor)).title)
    .toBe('Call Neil Jr.');
});

it('rejects an empty or whitespace-only title and writes nothing', async () => {
  const t = await make();
  for (const title of ['', '   ', '\n\t']) {
    await expect(editTask(db, t.id, { title }, actor)).rejects.toThrow(/non-empty/);
  }
  expect((await getTask(db, t.id))!.title).toBe('Call Neil');
  expect(await events(t.id, 'edited')).toBe(0);
});

it('writes nothing and logs nothing when the submit changes nothing', async () => {
  const t = await make({ assigneeId: 'U_JOSH' });
  const same = await editTask(db, t.id, {
    title: t.title, spaceId, status: 'open', assigneeId: 'U_JOSH',
    dueAt: null, details: null, waitingOn: null,
  }, actor);
  expect(same.title).toBe(t.title);
  expect(await events(t.id, 'edited')).toBe(0);
});

it('logs one edited event naming only the fields that changed', async () => {
  const t = await make();
  await editTask(db, t.id, { title: 'New title', status: 'waiting' }, actor);
  const { rows } = await db.query<{ detail: unknown }>(
    `SELECT detail FROM task_events WHERE task_id=$1 AND event='edited'`, [t.id]
  );
  expect(rows).toHaveLength(1);
  const detail = typeof rows[0]!.detail === 'string'
    ? JSON.parse(rows[0]!.detail as string) : (rows[0]!.detail as any);
  expect(Object.keys(detail.changed).sort()).toEqual(['status', 'title']);
  expect(detail.changed.title).toEqual({ from: 'Call Neil', to: 'New title' });
});

it('stamps completed_at from the database clock and clears it on reopen', async () => {
  const t = await make();
  const done = await editTask(db, t.id, { status: 'completed' }, actor);
  expect(done.status).toBe('completed');
  expect(done.completed_at).toBeInstanceOf(Date);

  const { rows } = await db.query<{ now: Date }>(`SELECT now() AS now`);
  expect(Math.abs(done.completed_at!.getTime() - new Date(rows[0]!.now).getTime()))
    .toBeLessThan(60_000);

  const back = await editTask(db, t.id, { status: 'open' }, actor);
  expect(back.completed_at).toBeNull();
});

it('preserves the original completed_at when re-completing', async () => {
  const t = await make();
  const first = await completeTask(db, t.id, actor);
  const again = await editTask(db, t.id, { status: 'completed', title: 'changed' }, actor);
  expect(again.completed_at!.getTime()).toBe(first.completed_at!.getTime());
});

it('clears waiting_on automatically when status is not waiting', async () => {
  const t = await make();
  await moveTask(db, t.id, { status: 'waiting', waitingOn: 'Neil' }, actor);
  const open = await editTask(db, t.id, { status: 'open' }, actor);
  expect(open.waiting_on).toBeNull();
});

it('keeps waiting_on when staying waiting and can update it', async () => {
  const t = await make();
  await editTask(db, t.id, { status: 'waiting', waitingOn: 'Neil' }, actor);
  const still = await editTask(db, t.id, { status: 'waiting' }, actor);
  expect(still.waiting_on).toBe('Neil');
  const changed = await editTask(db, t.id, { status: 'waiting', waitingOn: 'Rachael' }, actor);
  expect(changed.waiting_on).toBe('Rachael');
});

it('clears assignee, due date, and details with null', async () => {
  const t = await make({ assigneeId: 'U_JOSH', dueAt: new Date('2026-09-15T05:00:00Z') });
  await editTask(db, t.id, { details: 'notes' }, actor);
  const cleared = await editTask(db, t.id, {
    assigneeId: null, dueAt: null, details: null,
  }, actor);
  expect(cleared.assignee_id).toBeNull();
  expect(cleared.due_at).toBeNull();
  expect(cleared.details).toBeNull();
});

it('treats an empty details string as a clear', async () => {
  const t = await make();
  await editTask(db, t.id, { details: 'notes' }, actor);
  expect((await editTask(db, t.id, { details: '' }, actor)).details).toBeNull();
});

it('moves the task between spaces', async () => {
  const t = await make();
  expect((await editTask(db, t.id, { spaceId: otherSpaceId }, actor)).space_id)
    .toBe(otherSpaceId);
});

it('rejects an invalid due date and an invalid status', async () => {
  const t = await make();
  await expect(editTask(db, t.id, { dueAt: new Date('nope') }, actor))
    .rejects.toThrow(InvalidDueDateError);
  await expect(editTask(db, t.id, { status: 'archived' as never }, actor))
    .rejects.toThrow(/invalid status/);
});

it('rejects a malformed id before any SQL', async () => {
  await expect(editTask(db, 'not-a-uuid', { title: 'x' }, actor))
    .rejects.toThrow(InvalidTaskIdError);
});

it('ignores keys outside EditableFields', async () => {
  const t = await make();
  const before = await getTask(db, t.id);
  await editTask(db, t.id, {
    title: 'Legit change',
    id: '00000000-0000-4000-8000-000000000000',
    createdAt: new Date(0),
    created_at: new Date(0),
    sourcePlatform: 'hacked',
    source_platform: 'hacked',
    completedAt: new Date(0),
  } as never, actor);
  const after = (await getTask(db, t.id))!;
  expect(after.id).toBe(t.id);
  expect(after.title).toBe('Legit change');
  expect(after.source_platform).toBe(before!.source_platform);
  expect(after.created_at.getTime()).toBe(before!.created_at.getTime());
});
