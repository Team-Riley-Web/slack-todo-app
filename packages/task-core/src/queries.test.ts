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
