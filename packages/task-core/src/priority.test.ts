import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import {
  PRIORITIES, InvalidPriorityError, comparePriority, isPriority,
  parsePriority, priorityRank, priorityChoice,
} from './priority.js';
import { createTask, editTask, getTask } from './tasks.js';
import { listTasks } from './queries.js';
import { listOpenTasksBySpace } from './grouping.js';

describe('the priority values', () => {
  it('ranks P0 highest and unprioritized last', () => {
    expect(priorityRank('P0')).toBeLessThan(priorityRank('P1'));
    expect(priorityRank('P3')).toBeLessThan(priorityRank(null));
    expect(comparePriority('P0', 'P1')).toBeLessThan(0);
    expect(comparePriority('P3', null)).toBeLessThan(0);
    expect(comparePriority('P2', 'P2')).toBe(0);
  });

  /**
   * The reason the label is also the sort key: if these ever disagreed, SQL's
   * `ORDER BY priority` and the in-memory comparator would silently diverge.
   */
  it('sorts the same lexically as it does by rank', () => {
    const byRank = [...PRIORITIES].sort(comparePriority);
    const byString = [...PRIORITIES].sort();
    expect(byRank).toEqual(byString);
    expect(byRank).toEqual(['P0', 'P1', 'P2', 'P3']);
  });

  it('reads as "P0 — Critical" in a picker', () => {
    expect(priorityChoice('P0')).toBe('P0 — Critical');
    expect(priorityChoice('P3')).toBe('P3 — Low');
  });

  it('recognises only the four values', () => {
    for (const p of PRIORITIES) expect(isPriority(p)).toBe(true);
    for (const bad of ['P7', 'p0', 'P', '', 0, null, undefined]) {
      expect(isPriority(bad)).toBe(false);
    }
  });
});

describe('parsing a priority', () => {
  it('treats absent, null and empty string all as unprioritized', () => {
    // A form sends '' for "no priority" and JSON sends null; they must agree.
    expect(parsePriority(undefined)).toBeNull();
    expect(parsePriority(null)).toBeNull();
    expect(parsePriority('')).toBeNull();
  });

  it('accepts the four values unchanged', () => {
    for (const p of PRIORITIES) expect(parsePriority(p)).toBe(p);
  });

  /**
   * Throwing rather than coercing is the whole point: a typo'd P7 silently
   * becoming null is indistinguishable from a task nobody prioritised.
   */
  it('throws on anything else instead of quietly dropping it', () => {
    for (const bad of ['P7', 'p0', 'critical', 'P10', 0, true, {}]) {
      expect(() => parsePriority(bad)).toThrow(InvalidPriorityError);
    }
  });
});

describe('priority on a task', () => {
  let db: Db;
  let spaceId: string;
  const actor = { id: 'U_JOSH', source: 'test' };

  beforeEach(async () => {
    db = await createTestDb();
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM spaces WHERE name = 'Marketing'`
    );
    spaceId = rows[0]!.id;
  });
  afterEach(async () => { await db.close(); });

  const add = (title: string, priority?: unknown) =>
    createTask(db, { title, spaceId, priority: priority as never });

  it('stores a priority given at capture', async () => {
    const t = await add('Fix Stripe checkout', 'P0');
    expect(t.priority).toBe('P0');
    expect((await getTask(db, t.id))!.priority).toBe('P0');
  });

  it('defaults to null, so an existing task stays valid', async () => {
    const t = await add('No priority given');
    expect(t.priority).toBeNull();
  });

  it('refuses an invalid priority at capture and writes nothing', async () => {
    await expect(add('Bad', 'P7')).rejects.toThrow(InvalidPriorityError);
    const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks`);
    expect(rows[0]!.n).toBe(0);
  });

  it('can be changed, and cleared, through the edit path', async () => {
    const t = await add('Movable', 'P3');
    expect((await editTask(db, t.id, { priority: 'P0' }, actor)).priority).toBe('P0');
    expect((await editTask(db, t.id, { priority: null }, actor)).priority).toBeNull();
  });

  it('is left alone by an edit that does not mention it', async () => {
    const t = await add('Keep mine', 'P1');
    const edited = await editTask(db, t.id, { status: 'waiting' }, actor);
    expect(edited.priority).toBe('P1');
  });

  it('refuses an invalid priority on edit', async () => {
    const t = await add('Guarded', 'P1');
    await expect(editTask(db, t.id, { priority: 'P9' as never }, actor))
      .rejects.toThrow(InvalidPriorityError);
    expect((await getTask(db, t.id))!.priority).toBe('P1');
  });

  it('records the change in the edit event', async () => {
    const t = await add('Audited', 'P2');
    await editTask(db, t.id, { priority: 'P0' }, actor);
    const { rows } = await db.query<{ detail: unknown }>(
      `SELECT detail FROM task_events WHERE task_id=$1 AND event='edited'`, [t.id]
    );
    const detail = typeof rows[0]!.detail === 'string'
      ? JSON.parse(rows[0]!.detail as string) : (rows[0]!.detail as any);
    expect(detail.changed.priority).toEqual({ from: 'P2', to: 'P0' });
  });

  /** The database is the outer guard; task-core is not the only line of defence. */
  it('is rejected by the column constraint even when task-core is bypassed', async () => {
    await expect(
      db.query(`INSERT INTO tasks (title, space_id, priority) VALUES ('X', $1, 'P9')`, [spaceId])
    ).rejects.toThrow();
  });
});

describe('the shared ordering', () => {
  let db: Db;
  let spaceId: string;

  beforeEach(async () => {
    db = await createTestDb();
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM spaces WHERE name = 'Marketing'`
    );
    spaceId = rows[0]!.id;
  });
  afterEach(async () => { await db.close(); });

  it('puts P0 before P1 and P3 before unprioritized', async () => {
    // Inserted in deliberately the wrong order.
    for (const [title, priority] of [
      ['None', null], ['Low', 'P3'], ['Critical', 'P0'], ['Medium', 'P2'], ['High', 'P1'],
    ] as const) {
      await createTask(db, { title, spaceId, priority });
    }
    expect((await listTasks(db, { actionableOnly: true })).map((t) => t.title))
      .toEqual(['Critical', 'High', 'Medium', 'Low', 'None']);
  });

  it('falls back to the previous ordering within one priority level', async () => {
    // Same priority: due date first, then creation -- unchanged behaviour.
    await createTask(db, {
      title: 'Later', spaceId, priority: 'P1', dueAt: new Date('2026-12-01T00:00:00Z'),
    });
    await createTask(db, {
      title: 'Sooner', spaceId, priority: 'P1', dueAt: new Date('2026-10-01T00:00:00Z'),
    });
    await createTask(db, { title: 'Undated', spaceId, priority: 'P1' });
    expect((await listTasks(db, { actionableOnly: true })).map((t) => t.title))
      .toEqual(['Sooner', 'Later', 'Undated']);
  });

  it('beats the due date: a P0 with no date outranks a P3 due today', async () => {
    await createTask(db, {
      title: 'P3 due today', spaceId, priority: 'P3', dueAt: new Date(),
    });
    await createTask(db, { title: 'P0 undated', spaceId, priority: 'P0' });
    expect((await listTasks(db, { actionableOnly: true })).map((t) => t.title))
      .toEqual(['P0 undated', 'P3 due today']);
  });

  /**
   * `tasks all` and both scheduled digests route through listOpenTasksBySpace,
   * which routes through listTasks. Asserting here proves every one of those
   * surfaces inherits the order without each needing its own sort.
   */
  it('reaches `tasks all` and the daily digests through the shared query', async () => {
    for (const [title, priority] of [
      ['None', null], ['Low', 'P3'], ['Critical', 'P0'], ['High', 'P1'],
    ] as const) {
      await createTask(db, { title, spaceId, priority });
    }
    const { entries, groups } = await listOpenTasksBySpace(db);
    expect(entries.map((e) => e.task.title))
      .toEqual(['Critical', 'High', 'Low', 'None']);
    expect(groups[0]!.entries.map((e) => e.task.title))
      .toEqual(['Critical', 'High', 'Low', 'None']);
  });

  it('filters to one priority, and to the unprioritized ones', async () => {
    await createTask(db, { title: 'A', spaceId, priority: 'P0' });
    await createTask(db, { title: 'B', spaceId, priority: 'P2' });
    await createTask(db, { title: 'C', spaceId });

    expect((await listTasks(db, { priority: 'P0' })).map((t) => t.title)).toEqual(['A']);
    // Explicit null is a filter; omitting the key is not.
    expect((await listTasks(db, { priority: null })).map((t) => t.title)).toEqual(['C']);
    expect((await listTasks(db, {})).map((t) => t.title)).toEqual(['A', 'B', 'C']);
  });
});
