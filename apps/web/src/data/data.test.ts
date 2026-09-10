import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask, completeTask, moveTask, getTask } from '@tr/task-core';
import { buildServer } from '../../../api/src/server.js';
import { parseFilters, filtersToQuery, withFilter } from './filters.js';
import {
  myTasks, waitingTasks, history, spaceSummary, knownAssignees,
} from './tasks.js';

let db: Db;
const spaceIds: Record<string, string> = {};
const actor = { id: 'U_JOSH', source: 'web' };

beforeEach(async () => {
  db = await createTestDb();
  const { rows } = await db.query<{ id: string; name: string }>(`SELECT id, name FROM spaces`);
  for (const r of rows) spaceIds[r.name] = r.id;
});
afterEach(async () => { await db.close(); });

const add = (space: string, title: string, over: Record<string, unknown> = {}) =>
  createTask(db, { title, spaceId: spaceIds[space]!, ...over } as never);

describe('parseFilters', () => {
  it('reads every supported key', () => {
    expect(parseFilters({
      space: 'marketing', status: 'waiting', assignee: 'U_JOSH',
      due: 'overdue', q: 'neil', from: '2026-01-01', to: '2026-02-01',
    })).toEqual({
      space: 'marketing', status: 'waiting', assignee: 'U_JOSH',
      due: 'overdue', q: 'neil', from: '2026-01-01', to: '2026-02-01',
    });
  });

  it('ignores unknown keys', () => {
    expect(parseFilters({ nonsense: 'x', space: 'marketing' }))
      .toEqual({ space: 'marketing' });
  });

  it('takes the first value of a repeated parameter', () => {
    expect(parseFilters({ space: ['marketing', 'sales'] })).toEqual({ space: 'marketing' });
  });

  it('drops an invalid status or due bucket rather than passing it through', () => {
    expect(parseFilters({ status: 'archived', due: 'someday' })).toEqual({});
  });

  it('drops a malformed date', () => {
    expect(parseFilters({ from: '01/01/2026', to: 'yesterday' })).toEqual({});
  });

  it('treats empty and whitespace values as absent', () => {
    expect(parseFilters({ q: '', space: '   ' })).toEqual({});
  });

  it('round-trips through filtersToQuery', () => {
    const filters = { space: 'marketing', q: 'neil', due: 'week' as const };
    const query = filtersToQuery(filters);
    const params = Object.fromEntries(new URLSearchParams(query.slice(1)));
    expect(parseFilters(params)).toEqual(filters);
  });

  it('produces an empty string for no filters, not a bare question mark', () => {
    expect(filtersToQuery({})).toBe('');
  });

  it('withFilter sets and clears one key', () => {
    const base = { space: 'marketing', q: 'neil' };
    expect(withFilter(base, 'status', 'waiting'))
      .toEqual({ space: 'marketing', q: 'neil', status: 'waiting' });
    expect(withFilter(base, 'q', undefined)).toEqual({ space: 'marketing' });
  });
});

describe('myTasks', () => {
  it('shows open tasks only', async () => {
    await add('Marketing', 'Open one');
    const w = await add('Marketing', 'Waiting one');
    const c = await add('Marketing', 'Done one');
    await moveTask(db, w.id, { status: 'waiting' }, actor);
    await completeTask(db, c.id, actor);

    expect((await myTasks(db, {})).map((r) => r.task.title)).toEqual(['Open one']);
  });

  it('attaches the Space to each row', async () => {
    await add('Client - Nazareth Law', 'Call Neil');
    const rows = await myTasks(db, {});
    expect(rows[0]!.space.name).toBe('Client - Nazareth Law');
  });

  it('filters by space slug', async () => {
    await add('Marketing', 'Mkt');
    await add('Sales', 'Sales');
    expect((await myTasks(db, { space: 'sales' })).map((r) => r.task.title)).toEqual(['Sales']);
  });

  it('returns nothing for an unknown space slug rather than everything', async () => {
    await add('Marketing', 'Mkt');
    expect(await myTasks(db, { space: 'no-such-space' })).toEqual([]);
  });

  it('filters by assignee and by status', async () => {
    await add('Marketing', 'Mine', { assigneeId: 'U_JOSH' });
    await add('Marketing', 'Theirs', { assigneeId: 'U_RACHAEL' });
    const w = await add('Marketing', 'Parked');
    await moveTask(db, w.id, { status: 'waiting' }, actor);

    expect((await myTasks(db, { assignee: 'U_JOSH' })).map((r) => r.task.title))
      .toEqual(['Mine']);
    expect((await myTasks(db, { status: 'waiting' })).map((r) => r.task.title))
      .toEqual(['Parked']);
  });

  it('filters by due bucket', async () => {
    await add('Marketing', 'Overdue', { dueAt: new Date(Date.now() - 86_400_000) });
    await add('Marketing', 'No date');
    expect((await myTasks(db, { due: 'overdue' })).map((r) => r.task.title))
      .toEqual(['Overdue']);
    expect((await myTasks(db, { due: 'none' })).map((r) => r.task.title))
      .toEqual(['No date']);
  });

  it('searches titles, treating LIKE metacharacters literally', async () => {
    await add('Marketing', 'Bring Neil to 50% off');
    await add('Marketing', 'Unrelated');
    expect((await myTasks(db, { q: 'neil' })).map((r) => r.task.title))
      .toEqual(['Bring Neil to 50% off']);
    expect(await myTasks(db, { q: '_' })).toEqual([]);
  });

  it('combines filters', async () => {
    await add('Marketing', 'Call Neil', { assigneeId: 'U_JOSH' });
    await add('Sales', 'Call Neil', { assigneeId: 'U_JOSH' });
    await add('Marketing', 'Call Neil', { assigneeId: 'U_RACHAEL' });
    const rows = await myTasks(db, { space: 'marketing', assignee: 'U_JOSH', q: 'neil' });
    expect(rows).toHaveLength(1);
  });
});

describe('waitingTasks', () => {
  it('shows only waiting tasks, with waiting_on intact', async () => {
    const w = await add('Client - Milltown Cabinets', 'Waiting on Milltown’s reply');
    await add('Marketing', 'Open');
    const c = await add('Marketing', 'Done');
    await completeTask(db, c.id, actor);
    await moveTask(db, w.id, { status: 'waiting', waitingOn: 'email proposal' }, actor);

    const rows = await waitingTasks(db, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.task.title).toBe('Waiting on Milltown’s reply');
    expect(rows[0]!.task.waiting_on).toBe('email proposal');
    expect(rows[0]!.space.name).toBe('Client - Milltown Cabinets');
  });

  it('can be narrowed by space and search', async () => {
    const a = await add('Marketing', 'Waiting A');
    const b = await add('Sales', 'Waiting B');
    await moveTask(db, a.id, { status: 'waiting' }, actor);
    await moveTask(db, b.id, { status: 'waiting' }, actor);
    expect(await waitingTasks(db, { space: 'sales' })).toHaveLength(1);
    expect(await waitingTasks(db, { q: 'waiting a' })).toHaveLength(1);
  });
});

describe('history', () => {
  const complete = async (title: string, when: string) => {
    const t = await add('Marketing', title);
    await completeTask(db, t.id, actor);
    await db.query(`UPDATE tasks SET completed_at = $2 WHERE id = $1`, [t.id, when]);
    return t;
  };

  it('shows only completed tasks, newest completion first', async () => {
    await complete('Older', '2026-01-01T00:00:00Z');
    await complete('Newer', '2026-06-01T00:00:00Z');
    await add('Marketing', 'Still open');

    expect((await history(db, {})).map((r) => r.task.title)).toEqual(['Newer', 'Older']);
  });

  it('carries the fields the history view needs', async () => {
    const t = await add('Marketing', 'From Slack', {
      sourcePlatform: 'slack', sourceChannelId: 'C1', sourceMessageTs: '1.1',
    });
    await completeTask(db, t.id, actor);

    const row = (await history(db, {}))[0]!;
    expect(row.task.completed_at).toBeInstanceOf(Date);
    expect(row.task.created_at).toBeInstanceOf(Date);
    expect(row.task.source_platform).toBe('slack');
    expect(row.task.source_channel_id).toBe('C1');
    expect(row.task.source_message_ts).toBe('1.1');
  });

  it('respects a half-open date range', async () => {
    await complete('In range', '2026-06-15T12:00:00Z');

    expect(await history(db, { from: '2026-06-15', to: '2026-06-16' })).toHaveLength(1);
    expect(await history(db, { from: '2026-06-16', to: '2026-06-17' })).toHaveLength(0);
    // `to` is exclusive, so a range ending on the completion day excludes it.
    expect(await history(db, { from: '2026-06-01', to: '2026-06-15' })).toHaveLength(0);
  });

  it('can be narrowed by space, assignee, and text within a range', async () => {
    const t = await add('Marketing', 'Findable', { assigneeId: 'U_JOSH' });
    await completeTask(db, t.id, actor);
    await db.query(`UPDATE tasks SET completed_at = '2026-06-15T12:00:00Z' WHERE id = $1`, [t.id]);

    const range = { from: '2026-06-01', to: '2026-07-01' };
    expect(await history(db, { ...range, q: 'findable' })).toHaveLength(1);
    expect(await history(db, { ...range, q: 'nothing' })).toHaveLength(0);
    expect(await history(db, { ...range, assignee: 'U_JOSH' })).toHaveLength(1);
    expect(await history(db, { ...range, assignee: 'U_OTHER' })).toHaveLength(0);
    expect(await history(db, { ...range, space: 'sales' })).toHaveLength(0);
  });
});

describe('spaceSummary', () => {
  it('reports open, waiting and completed per Space', async () => {
    await add('Marketing', 'Open');
    const w = await add('Marketing', 'Waiting');
    const c = await add('Marketing', 'Done');
    await moveTask(db, w.id, { status: 'waiting' }, actor);
    await completeTask(db, c.id, actor);

    const rows = await spaceSummary(db);
    const marketing = rows.find((r) => r.space.name === 'Marketing')!;
    expect(marketing).toMatchObject({ open: 1, waiting: 1, completed: 1 });
  });

  it('includes Spaces with nothing in them, unlike the Slack summary', async () => {
    const rows = await spaceSummary(db);
    expect(rows).toHaveLength(12); // every seeded Space
    expect(rows.every((r) => r.open === 0 && r.waiting === 0 && r.completed === 0)).toBe(true);
  });
});

describe('knownAssignees', () => {
  it('lists the distinct assignees in use', async () => {
    await add('Marketing', 'A', { assigneeId: 'U_JOSH' });
    await add('Marketing', 'B', { assigneeId: 'U_JOSH' });
    await add('Marketing', 'C', { assigneeId: 'U_RACHAEL' });
    await add('Marketing', 'D');
    expect(await knownAssignees(db)).toEqual(['U_JOSH', 'U_RACHAEL']);
  });
});

describe('one database, two views', () => {
  // Brief test 1: the same task must read identically through the API and the
  // web data layer, because there is only one database.
  it('reads a task identically through the REST API and the web layer', async () => {
    const created = await add('Client - Nazareth Law',
      'Offer Neil Instagram and Facebook package for $100',
      { assigneeId: 'U_JOSH', dueAt: new Date('2026-09-15T05:00:00Z') });

    const app = buildServer({ db, apiToken: 't' });
    const res = await app.inject({
      method: 'GET', url: `/tasks/${created.id}`,
      headers: { authorization: 'Bearer t' },
    });
    const viaApi = res.json().task;

    const viaWeb = (await myTasks(db, {}))[0]!.task;

    expect(viaWeb.id).toBe(viaApi.id);
    expect(viaWeb.title).toBe(viaApi.title);
    expect(viaWeb.status).toBe(viaApi.status);
    expect(viaWeb.assignee_id).toBe(viaApi.assignee_id);
    expect(viaWeb.due_at?.toISOString()).toBe(viaApi.due_at);
    expect(viaWeb.space_id).toBe(viaApi.space_id);
    await app.close();
  });

  it('shows a Slack completion immediately in the web layer', async () => {
    const t = await add('Marketing', 'Completed in Slack');
    expect(await myTasks(db, {})).toHaveLength(1);

    // Exactly what the Slack checkbox handler calls.
    await completeTask(db, t.id, { id: 'U_JOSH', source: 'slack' });

    expect(await myTasks(db, {})).toHaveLength(0);
    expect((await history(db, {})).map((r) => r.task.title)).toEqual(['Completed in Slack']);
    expect((await getTask(db, t.id))!.status).toBe('completed');
  });
});
