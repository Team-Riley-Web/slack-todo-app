import { priorityRank, type Space, type Task } from '@tr/task-core';
import type { SortDir, SortKey, TaskFilters } from '@/data/filters';
import { filterHref, shortSpaceName } from '@/lib/display';

/**
 * Ordering a task list by a column.
 *
 * Done in the page rather than in SQL: a list here is tens of rows, the
 * values being sorted are the DISPLAYED ones (a Space without its "Client - "
 * prefix, an assignee's name rather than their Slack id), and those are
 * known here and not in the query.
 *
 * Two rules hold for every column:
 *
 * - **Empty sorts last, in both directions.** A task with no due date is not
 *   "earlier" than one due tomorrow, and flipping the direction should not
 *   drag twenty undated tasks to the top of the list.
 * - **Ties keep the query's order.** The sort is stable, so reversing a
 *   column never shuffles rows that compare equal.
 */

type Row = { task: Task; space: Space };
type Value = string | number | null;

const text = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

function valueOf(
  row: Row, key: SortKey, labels: Record<string, string>, now: number
): Value {
  const { task, space } = row;
  switch (key) {
    case 'title':
      return task.title;
    case 'space':
      return shortSpaceName(space);
    case 'assignee':
      return task.assignee_id ? labels[task.assignee_id] ?? task.assignee_id : null;
    case 'due': {
      // The column shows the completion date for a completed task, so that is
      // what it sorts by -- sorting by an invisible due date would look random.
      const when = task.status === 'completed' && task.completed_at
        ? task.completed_at
        : task.due_at;
      return when ? when.getTime() : null;
    }
    case 'priority':
      /*
       * The RANK for a real priority, and null for none.
       *
       * Both halves matter. The rank rather than the label because 'P0' < 'P1'
       * only sorts correctly by accident of the alphabet. null rather than
       * priorityRank's own 4 because the empty-last rule above is what keeps
       * unprioritized tasks at the BOTTOM when the column is reversed -- as a
       * number, 4 is simply the largest, so descending floated every
       * unprioritized task to the top.
       */
      return task.priority ? priorityRank(task.priority) : null;
    case 'waiting':
      return task.waiting_on ?? null;
    case 'age':
      // Age, not creation time: ascending means youngest first.
      return now - task.created_at.getTime();
  }
}

function compare(a: Value, b: Value): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return text.compare(String(a), String(b));
}

export function sortRows<T extends Row>(
  rows: T[],
  filters: Pick<TaskFilters, 'sort' | 'dir'>,
  labels: Record<string, string> = {},
  now: number = Date.now()
): T[] {
  const key = filters.sort;
  if (!key) return rows;
  const sign = filters.dir === 'desc' ? -1 : 1;

  return rows
    .map((row, index) => ({ row, index, value: valueOf(row, key, labels, now) }))
    .sort((a, b) => {
      if (a.value === null && b.value === null) return a.index - b.index;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      return sign * compare(a.value, b.value) || a.index - b.index;
    })
    .map(({ row }) => row);
}

/** What a header click should produce: this column ascending, or flipped. */
export function nextSort(
  filters: TaskFilters, key: SortKey
): Pick<TaskFilters, 'sort' | 'dir'> {
  const flipping = filters.sort === key && filters.dir !== 'desc';
  return { sort: key, dir: flipping ? 'desc' : 'asc' };
}

export interface Sorting {
  sort?: SortKey;
  dir?: SortDir;
  href: (key: SortKey) => string;
}

/**
 * The header's sort links for one page.
 *
 * Built from the URL's own filters, not a page's derived ones -- /today pins
 * `due=today` internally, and that should not leak into every link it makes.
 * An open edit pane is not carried: re-sorting closes it.
 */
export function sortingFor(path: string, filters: TaskFilters): Sorting {
  return {
    sort: filters.sort,
    dir: filters.dir,
    href: (key) => filterHref(path, { ...filters, ...nextSort(filters, key) }),
  };
}
