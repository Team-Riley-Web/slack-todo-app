import { describe, it, expect } from 'vitest';
import type { Space, Task } from '@tr/task-core';
import { sortRows, nextSort, sortingFor } from './sort.js';
import { parseFilters, filtersToQuery } from '@/data/filters';

const NOW = new Date('2026-09-10T12:00:00Z').getTime();

const space = (name: string): Space => ({
  id: `s-${name}`, name, slug: name.toLowerCase().replace(/\W+/g, '-'), is_inbox: false,
});

const task = (over: Partial<Task>): Task => ({
  id: 'T', title: 'x', space_id: 's', list_id: null, assignee_id: null,
  status: 'open', due_at: null, waiting_on: null, details: null,
  created_at: new Date('2026-09-01T00:00:00Z'), completed_at: null,
  source_platform: 'web', source_channel_id: null, source_message_ts: null,
  created_by: null, source_external_id: null, import_batch_id: null,
  ...over,
});

const row = (title: string, over: Partial<Task> = {}, s: Space = space('Agency')) =>
  ({ task: task({ id: title, title, ...over }), space: s });

const titles = (rows: Array<{ task: Task }>) => rows.map((r) => r.task.title);

describe('sortRows', () => {
  it('leaves the query order alone when no column is chosen', () => {
    const rows = [row('b'), row('a'), row('c')];
    expect(titles(sortRows(rows, {}))).toEqual(['b', 'a', 'c']);
  });

  it('sorts titles case-insensitively and numerically', () => {
    const rows = [row('item 10'), row('Banana'), row('item 2'), row('apple')];
    expect(titles(sortRows(rows, { sort: 'title', dir: 'asc' })))
      .toEqual(['apple', 'Banana', 'item 2', 'item 10']);
    expect(titles(sortRows(rows, { sort: 'title', dir: 'desc' })))
      .toEqual(['item 10', 'item 2', 'Banana', 'apple']);
  });

  it('sorts Spaces by their displayed name, without the client prefix', () => {
    // Stored, "Client - Zulu" sorts under C, before "Marketing". Shown as
    // "Zulu", it has to sort under Z or the column looks scrambled.
    const rows = [
      row('a', {}, space('Client - Zulu')),
      row('b', {}, space('Marketing')),
      row('c', {}, space('Client - Acme')),
    ];
    expect(titles(sortRows(rows, { sort: 'space', dir: 'asc' }))).toEqual(['c', 'b', 'a']);
  });

  it('sorts assignees by name, not Slack id', () => {
    const labels = { U_Z: 'Aaron', U_A: 'Zoe' };
    const rows = [row('zoe', { assignee_id: 'U_A' }), row('aaron', { assignee_id: 'U_Z' })];
    expect(titles(sortRows(rows, { sort: 'assignee', dir: 'asc' }, labels)))
      .toEqual(['aaron', 'zoe']);
  });

  it('puts empty values last in BOTH directions', () => {
    const rows = [
      row('none-1'),
      row('late', { due_at: new Date('2026-12-01') }),
      row('none-2'),
      row('soon', { due_at: new Date('2026-09-12') }),
    ];
    expect(titles(sortRows(rows, { sort: 'due', dir: 'asc' })))
      .toEqual(['soon', 'late', 'none-1', 'none-2']);
    expect(titles(sortRows(rows, { sort: 'due', dir: 'desc' })))
      .toEqual(['late', 'soon', 'none-1', 'none-2']);
  });

  it('sorts a completed task by its completion date, which is what the column shows', () => {
    const rows = [
      row('early', { status: 'completed', completed_at: new Date('2026-09-01'), due_at: new Date('2026-12-31') }),
      row('late', { status: 'completed', completed_at: new Date('2026-09-09'), due_at: new Date('2026-01-01') }),
    ];
    expect(titles(sortRows(rows, { sort: 'due', dir: 'asc' }))).toEqual(['early', 'late']);
  });

  it('sorts Age youngest first when ascending', () => {
    const rows = [
      row('old', { created_at: new Date('2026-08-01') }),
      row('new', { created_at: new Date('2026-09-09') }),
    ];
    expect(titles(sortRows(rows, { sort: 'age', dir: 'asc' }, {}, NOW))).toEqual(['new', 'old']);
  });

  it('keeps the query order for ties, so reversing never shuffles equals', () => {
    const rows = [row('1'), row('2'), row('3')]; // all Space "Agency"
    expect(titles(sortRows(rows, { sort: 'space', dir: 'asc' }))).toEqual(['1', '2', '3']);
    expect(titles(sortRows(rows, { sort: 'space', dir: 'desc' }))).toEqual(['1', '2', '3']);
  });

  it('does not mutate the array it was given', () => {
    const rows = [row('b'), row('a')];
    sortRows(rows, { sort: 'title', dir: 'asc' });
    expect(titles(rows)).toEqual(['b', 'a']);
  });
});

describe('nextSort', () => {
  it('starts a new column ascending, then flips it, then flips back', () => {
    expect(nextSort({}, 'due')).toEqual({ sort: 'due', dir: 'asc' });
    expect(nextSort({ sort: 'due', dir: 'asc' }, 'due')).toEqual({ sort: 'due', dir: 'desc' });
    expect(nextSort({ sort: 'due', dir: 'desc' }, 'due')).toEqual({ sort: 'due', dir: 'asc' });
  });

  it('switching column starts that column ascending', () => {
    expect(nextSort({ sort: 'due', dir: 'desc' }, 'title')).toEqual({ sort: 'title', dir: 'asc' });
  });
});

describe('sort in the URL', () => {
  it('keeps every other filter on a header link', () => {
    const href = sortingFor('/', { space: 'agency', due: 'week', q: 'neil' }).href('title');
    expect(href).toContain('space=agency');
    expect(href).toContain('due=week');
    expect(href).toContain('q=neil');
    expect(href).toContain('sort=title');
    expect(href).toContain('dir=asc');
  });

  it('round-trips through the query string', () => {
    const f = parseFilters({ sort: 'due', dir: 'desc', space: 'agency' });
    expect(f).toMatchObject({ sort: 'due', dir: 'desc', space: 'agency' });
    expect(parseFilters(Object.fromEntries(new URLSearchParams(filtersToQuery(f)))))
      .toEqual(f);
  });

  it('drops an unknown column and a direction with no column', () => {
    expect(parseFilters({ sort: 'created_by; DROP TABLE' }).sort).toBeUndefined();
    expect(parseFilters({ dir: 'desc' }).dir).toBeUndefined();
  });

  it('treats any direction other than desc as ascending', () => {
    expect(parseFilters({ sort: 'title', dir: 'sideways' }).dir).toBe('asc');
  });
});
