import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask, completeTask, moveTask } from './tasks.js';
import {
  openCountBySpace, completedBetween, createdBetween, createdThisWeek,
  completedThisWeek, averageTaskAgeDays, staleTasks, startOfWeek,
} from './reports.js';

let db: Db;
const spaceIds: Record<string, string> = {};
const actor = { id: 'U_JOSH', source: 'test' };

beforeEach(async () => {
  db = await createTestDb();
  const { rows } = await db.query<{ id: string; name: string }>(`SELECT id, name FROM spaces`);
  for (const r of rows) spaceIds[r.name] = r.id;
});
afterEach(async () => { await db.close(); });

const add = (space: string, title: string) =>
  createTask(db, { title, spaceId: spaceIds[space]! });

/** Ages a task by rewriting its created_at, which is otherwise now(). */
const age = (id: string, days: number) =>
  db.query(`UPDATE tasks SET created_at = now() - ($2 || ' days')::interval WHERE id = $1`,
    [id, String(days)]);

const completedAt = (id: string, when: string) =>
  db.query(`UPDATE tasks SET completed_at = $2 WHERE id = $1`, [id, when]);

describe('openCountBySpace', () => {
  it('counts open tasks and omits spaces with none', async () => {
    await add('Marketing', 'A');
    await add('Marketing', 'B');
    await add('Sales', 'C');
    const counts = await openCountBySpace(db);
    expect(counts.map((c) => [c.space_name, c.open]))
      .toEqual([['Marketing', 2], ['Sales', 1]]);
  });

  it('excludes waiting and completed tasks', async () => {
    const w = await add('Marketing', 'Waiting');
    const c = await add('Marketing', 'Done');
    await add('Marketing', 'Open');
    await moveTask(db, w.id, { status: 'waiting' }, actor);
    await completeTask(db, c.id, actor);
    expect(await openCountBySpace(db)).toEqual([
      { space_id: spaceIds['Marketing']!, space_name: 'Marketing', open: 1 },
    ]);
  });
});

describe('completedBetween', () => {
  it('uses a half-open range, so abutting ranges never double-count', async () => {
    const t = await add('Marketing', 'Boundary');
    await completeTask(db, t.id, actor);
    await completedAt(t.id, '2026-06-15T12:00:00Z');

    const inRange = await completedBetween(
      db, new Date('2026-06-15T12:00:00Z'), new Date('2026-06-16T00:00:00Z')
    );
    expect(inRange).toHaveLength(1); // `from` is inclusive

    const after = await completedBetween(
      db, new Date('2026-06-16T00:00:00Z'), new Date('2026-06-17T00:00:00Z')
    );
    expect(after).toHaveLength(0);

    const endingExactly = await completedBetween(
      db, new Date('2026-06-01T00:00:00Z'), new Date('2026-06-15T12:00:00Z')
    );
    expect(endingExactly).toHaveLength(0); // `to` is exclusive
  });

  it('scopes to a space when asked', async () => {
    for (const [space, title] of [['Marketing', 'M'], ['Sales', 'S']] as const) {
      const t = await add(space, title);
      await completeTask(db, t.id, actor);
      await completedAt(t.id, '2026-06-15T12:00:00Z');
    }
    const scoped = await completedBetween(
      db, new Date('2026-06-01'), new Date('2026-07-01'),
      { spaceId: spaceIds['Sales']! }
    );
    expect(scoped.map((t) => t.title)).toEqual(['S']);
  });

  it('excludes tasks that are not completed', async () => {
    await add('Marketing', 'Still open');
    expect(await completedBetween(db, new Date('2000-01-01'), new Date('2100-01-01')))
      .toHaveLength(0);
  });
});

describe('this week', () => {
  it('starts the week on Monday at midnight UTC', () => {
    // 2026-09-10 is a Thursday.
    expect(startOfWeek(new Date('2026-09-10T18:00:00Z')).toISOString())
      .toBe('2026-09-07T00:00:00.000Z');
    // A Monday is its own start.
    expect(startOfWeek(new Date('2026-09-07T00:30:00Z')).toISOString())
      .toBe('2026-09-07T00:00:00.000Z');
    // A Sunday belongs to the week that began the previous Monday.
    expect(startOfWeek(new Date('2026-09-13T23:00:00Z')).toISOString())
      .toBe('2026-09-07T00:00:00.000Z');
  });

  it('counts tasks created this week and ignores older ones', async () => {
    const recent = await add('Marketing', 'This week');
    const old = await add('Marketing', 'Ages ago');
    await age(old.id, 40);
    const rows = await createdThisWeek(db);
    expect(rows.map((t) => t.title)).toEqual(['This week']);
    expect(recent.id).toBeTruthy();
  });

  it('counts tasks completed this week', async () => {
    const t = await add('Marketing', 'Finished');
    await completeTask(db, t.id, actor);
    expect((await completedThisWeek(db)).map((x) => x.title)).toEqual(['Finished']);

    await completedAt(t.id, '2020-01-06T12:00:00Z');
    expect(await completedThisWeek(db)).toHaveLength(0);
  });

  it('createdBetween respects its bounds', async () => {
    const t = await add('Marketing', 'Aged');
    await age(t.id, 10);
    const from = new Date(Date.now() - 12 * 86_400_000);
    const to = new Date(Date.now() - 8 * 86_400_000);
    expect(await createdBetween(db, from, to)).toHaveLength(1);
    expect(await createdBetween(db, to, new Date())).toHaveLength(0);
  });
});

describe('averageTaskAgeDays', () => {
  it('averages the age of open tasks only', async () => {
    const a = await add('Marketing', 'Ten days');
    const b = await add('Marketing', 'Twenty days');
    const done = await add('Marketing', 'Old and finished');
    await age(a.id, 10);
    await age(b.id, 20);
    await age(done.id, 400);
    await completeTask(db, done.id, actor);

    const avg = await averageTaskAgeDays(db);
    expect(avg).not.toBeNull();
    expect(avg!).toBeGreaterThan(14.9);
    expect(avg!).toBeLessThan(15.1); // 400-day task excluded
  });

  it('excludes waiting tasks from the average', async () => {
    const a = await add('Marketing', 'Open');
    const w = await add('Marketing', 'Parked');
    await age(a.id, 10);
    await age(w.id, 100);
    await moveTask(db, w.id, { status: 'waiting' }, actor);
    const avg = await averageTaskAgeDays(db);
    expect(avg!).toBeGreaterThan(9.9);
    expect(avg!).toBeLessThan(10.1);
  });

  it('returns null when there is nothing open', async () => {
    expect(await averageTaskAgeDays(db)).toBeNull();
  });
});

describe('staleTasks', () => {
  it('returns open tasks older than the threshold, oldest first', async () => {
    const old = await add('Marketing', 'Very old');
    const mid = await add('Marketing', 'Somewhat old');
    await add('Marketing', 'Fresh');
    await age(old.id, 90);
    await age(mid.id, 45);

    const stale = await staleTasks(db, 30);
    expect(stale.map((t) => t.title)).toEqual(['Very old', 'Somewhat old']);
  });

  it('excludes waiting tasks, which are parked on purpose', async () => {
    const w = await add('Marketing', 'Parked ages ago');
    await age(w.id, 200);
    await moveTask(db, w.id, { status: 'waiting' }, actor);
    expect(await staleTasks(db, 30)).toHaveLength(0);
  });

  it('excludes completed tasks', async () => {
    const c = await add('Marketing', 'Old but done');
    await age(c.id, 200);
    await completeTask(db, c.id, actor);
    expect(await staleTasks(db, 30)).toHaveLength(0);
  });

  it('scopes to a space and handles an absurd threshold', async () => {
    const m = await add('Marketing', 'M old');
    const s = await add('Sales', 'S old');
    await age(m.id, 100);
    await age(s.id, 100);
    expect((await staleTasks(db, 30, { spaceId: spaceIds['Sales']! })).map((t) => t.title))
      .toEqual(['S old']);
    expect(await staleTasks(db, -5)).toHaveLength(2); // floored to 0 days
  });
});
