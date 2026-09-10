import { it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask, completeTask, moveTask } from './tasks.js';
import { listTasks, listWaiting, getTaskCounts } from './queries.js';

let db: Db;
const actor = { id: 'U_JOSH', source: 'test' };
const spaceIds: Record<string, string> = {};

beforeEach(async () => {
  db = await createTestDb();
  const { rows } = await db.query<{ id: string; name: string }>(`SELECT id, name FROM spaces`);
  for (const r of rows) spaceIds[r.name] = r.id;
});
afterEach(async () => { await db.close(); });

const add = (space: string, title: string) =>
  createTask(db, { title, spaceId: spaceIds[space]!, assigneeId: 'U_JOSH' });

// Required tests 9, 12
it('counts only open and waiting, never completed', async () => {
  const a = await add('Agency / Internal', 'A');
  await add('Agency / Internal', 'B');
  const w = await add('Agency / Internal', 'C');
  await add('Marketing', 'D');

  await completeTask(db, a.id, actor);
  await moveTask(db, w.id, { status: 'waiting', waitingOn: 'Neil' }, actor);

  const counts = await getTaskCounts(db);
  const agency = counts.find((c) => c.space_name === 'Agency / Internal')!;
  expect(agency.open).toBe(1);
  expect(agency.waiting).toBe(1);
  expect(counts.find((c) => c.space_name === 'Marketing')!.open).toBe(1);
  expect(counts.find((c) => c.space_name === 'Sales')).toBeUndefined();
});

// Required test 10
it('excludes waiting tasks from the actionable list', async () => {
  const w = await add('Agency / Internal', 'Waiting one');
  await add('Agency / Internal', 'Open one');
  await moveTask(db, w.id, { status: 'waiting' }, actor);

  const actionable = await listTasks(db, { actionableOnly: true });
  expect(actionable.map((t) => t.title)).toEqual(['Open one']);
});

// Required test 9
it('excludes completed tasks from the actionable list', async () => {
  const c = await add('Marketing', 'Done one');
  await add('Marketing', 'Live one');
  await completeTask(db, c.id, actor);
  const actionable = await listTasks(db, { actionableOnly: true });
  expect(actionable.map((t) => t.title)).toEqual(['Live one']);
});

// Required test 13
it('scopes a list to one space', async () => {
  await add('Agency / Internal', 'Agency task');
  await add('Personal', 'Personal task');
  const scoped = await listTasks(db, {
    spaceId: spaceIds['Personal']!, actionableOnly: true,
  });
  expect(scoped.map((t) => t.title)).toEqual(['Personal task']);
});

it('lists waiting tasks with their waiting_on', async () => {
  const w = await add('Client - Milltown Cabinets', 'Waiting on Milltown’s reply');
  await moveTask(db, w.id, { status: 'waiting', waitingOn: 'email proposal reply' }, actor);
  await add('Marketing', 'Not waiting');
  const waiting = await listWaiting(db);
  expect(waiting).toHaveLength(1);
  expect(waiting[0]!.title).toBe('Waiting on Milltown’s reply');
  expect(waiting[0]!.waiting_on).toBe('email proposal reply');
});

it('orders by due date first, then creation, so undated tasks trail dated ones', async () => {
  await createTask(db, {
    title: 'later', spaceId: spaceIds['Sales']!, dueAt: new Date('2026-12-01T00:00:00Z'),
  });
  await createTask(db, {
    title: 'sooner', spaceId: spaceIds['Sales']!, dueAt: new Date('2026-10-01T00:00:00Z'),
  });
  await createTask(db, { title: 'undated', spaceId: spaceIds['Sales']! });
  const rows = await listTasks(db, { spaceId: spaceIds['Sales']!, actionableOnly: true });
  expect(rows.map((t) => t.title)).toEqual(['sooner', 'later', 'undated']);
});

// Regression: ISSUE-003 — a non-numeric ?limit= became LIMIT NaN and errored
// the whole request instead of falling back to the default.
// Found by /qa on 2026-09-09
// Report: .gstack/qa-reports/qa-report-team-riley-tasks-2026-09-09.md
it('falls back to the default limit for any non-numeric or absurd value', async () => {
  await add('Marketing', 'A');
  for (const limit of [Number.NaN, 0, -5, Infinity, '10' as never, null as never, {} as never]) {
    const rows = await listTasks(db, { limit });
    expect(rows).toHaveLength(1);
  }
});

it('honours a valid limit and caps it at 500', async () => {
  await add('Marketing', 'A');
  await add('Marketing', 'B');
  expect(await listTasks(db, { limit: 1 })).toHaveLength(1);
  expect(await listTasks(db, { limit: 1.9 })).toHaveLength(1); // floored
  expect(await listTasks(db, { limit: 100_000 })).toHaveLength(2);
});

// --- text search and due buckets, added for the web UI ---

it('matches a case-insensitive substring of the title', async () => {
  await add('Marketing', 'Offer Neil Instagram and Facebook package');
  await add('Marketing', 'Call Rachael');
  expect((await listTasks(db, { titleContains: 'neil' })).map((t) => t.title))
    .toEqual(['Offer Neil Instagram and Facebook package']);
  expect((await listTasks(db, { titleContains: 'INSTAGRAM' }))).toHaveLength(1);
});

it('searches titles only, never space names', async () => {
  await add('Marketing', 'Nothing relevant');
  expect(await listTasks(db, { titleContains: 'marketing' })).toHaveLength(0);
});

it('treats LIKE metacharacters in a search as literal text', async () => {
  await add('Marketing', 'Bring Neil to 50% off');
  await add('Marketing', 'Unrelated');
  expect((await listTasks(db, { titleContains: '50%' })).map((t) => t.title))
    .toEqual(['Bring Neil to 50% off']);

  // A bare % is a literal percent sign, so it finds the one title that has
  // one - it does NOT match every row the way an unescaped wildcard would.
  expect((await listTasks(db, { titleContains: '%' })).map((t) => t.title))
    .toEqual(['Bring Neil to 50% off']);

  // A bare _ is a literal underscore, which no title here contains. Unescaped
  // it would match any single character and return everything.
  expect(await listTasks(db, { titleContains: '_' })).toHaveLength(0);
});

it('finds a title containing a curly apostrophe', async () => {
  await add('Marketing', 'Waiting on Milltown’s reply');
  expect(await listTasks(db, { titleContains: 'milltown’s' })).toHaveLength(1);
});

it('buckets due dates', async () => {
  const overdue = await createTask(db, {
    title: 'Overdue', spaceId: spaceIds['Marketing']!,
    dueAt: new Date(Date.now() - 86_400_000),
  });
  await createTask(db, {
    title: 'Soon', spaceId: spaceIds['Marketing']!,
    dueAt: new Date(Date.now() + 3 * 86_400_000),
  });
  await createTask(db, {
    title: 'Far off', spaceId: spaceIds['Marketing']!,
    dueAt: new Date(Date.now() + 60 * 86_400_000),
  });
  await add('Marketing', 'No due date');

  expect((await listTasks(db, { due: 'overdue' })).map((t) => t.title)).toEqual(['Overdue']);
  expect((await listTasks(db, { due: 'week' })).map((t) => t.title).sort())
    .toEqual(['Overdue', 'Soon']);
  expect((await listTasks(db, { due: 'none' })).map((t) => t.title)).toEqual(['No due date']);
  expect(overdue.due_at).toBeInstanceOf(Date);
});

it('combines a search with a space and a status filter', async () => {
  const w = await add('Marketing', 'Call Neil about pricing');
  await add('Sales', 'Call Neil about pricing');
  await moveTask(db, w.id, { status: 'waiting' }, actor);

  const rows = await listTasks(db, {
    titleContains: 'neil', spaceId: spaceIds['Marketing']!, status: 'waiting',
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.space_id).toBe(spaceIds['Marketing']);
});

it('ignores an empty or whitespace-only search', async () => {
  await add('Marketing', 'A');
  await add('Sales', 'B');
  expect(await listTasks(db, { titleContains: '' })).toHaveLength(2);
  expect(await listTasks(db, { titleContains: '   ' })).toHaveLength(2);
});
