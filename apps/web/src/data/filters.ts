import type { DueBucket, TaskStatus } from '@tr/task-core';

const STATUSES: TaskStatus[] = ['open', 'waiting', 'completed'];
const DUE_BUCKETS: DueBucket[] = ['overdue', 'today', 'week', 'none'];

/** The columns a task list can be ordered by. */
export const SORT_KEYS = ['title', 'priority', 'space', 'waiting', 'age', 'assignee', 'due'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

export interface TaskFilters {
  /** Space slug, not id — slugs are stable and readable in a URL. */
  space?: string;
  status?: TaskStatus;
  assignee?: string;
  due?: DueBucket;
  q?: string;
  /** History only. ISO dates, half-open: from inclusive, to exclusive. */
  from?: string;
  to?: string;
  /** Column ordering, from a header click. Absent means the query's own order. */
  sort?: SortKey;
  dir?: SortDir;
}

type RawParams = Record<string, string | string[] | undefined>;

/** A repeated query parameter takes its first value rather than erroring. */
function one(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads filters out of the URL.
 *
 * Unknown keys are ignored and invalid values are dropped rather than passed
 * through, so a hand-edited URL narrows the view or does nothing — it never
 * reaches SQL as something unexpected.
 */
export function parseFilters(params: RawParams): TaskFilters {
  const filters: TaskFilters = {};

  const space = one(params.space);
  if (space) filters.space = space;

  const status = one(params.status);
  if (status && (STATUSES as string[]).includes(status)) {
    filters.status = status as TaskStatus;
  }

  const assignee = one(params.assignee);
  if (assignee) filters.assignee = assignee;

  const due = one(params.due);
  if (due && (DUE_BUCKETS as string[]).includes(due)) {
    filters.due = due as DueBucket;
  }

  const q = one(params.q);
  if (q) filters.q = q;

  const from = one(params.from);
  if (from && ISO_DATE.test(from)) filters.from = from;

  const to = one(params.to);
  if (to && ISO_DATE.test(to)) filters.to = to;

  const sort = one(params.sort);
  if (sort && (SORT_KEYS as readonly string[]).includes(sort)) {
    filters.sort = sort as SortKey;
    // A direction means nothing without a column, so it is only read here.
    filters.dir = one(params.dir) === 'desc' ? 'desc' : 'asc';
  }

  return filters;
}

/** Round-trips through parseFilters. An empty filter set produces ''. */
export function filtersToQuery(filters: TaskFilters): string {
  const params = new URLSearchParams();
  for (const key of [
    'space', 'status', 'assignee', 'due', 'q', 'from', 'to', 'sort', 'dir',
  ] as const) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query.length > 0 ? `?${query}` : '';
}

/** For filter links: the current filters with one key changed or cleared. */
export function withFilter(
  filters: TaskFilters, key: keyof TaskFilters, value: string | undefined
): TaskFilters {
  const next = { ...filters };
  if (value === undefined || value === '') delete next[key];
  else next[key] = value as never;
  return next;
}

/**
 * The query behind the Today card at the top of All spaces, or null when the
 * card should not show.
 *
 * Open tasks in the `today` bucket -- overdue, or due within the next day --
 * which is exactly what the Due Today page lists, so the card and that page
 * never disagree about what "today" means. Assignee and search still narrow it,
 * the same as every card beneath it.
 *
 * It stays off when the page is already narrowed by Space or by a due chip.
 * On one Space the page IS that Space's list; under "Overdue" or "This week"
 * every card below is already a due-date view, and a Today card above them
 * would repeat what they show.
 */
export function todayFocusFilters(filters: TaskFilters): TaskFilters | null {
  if (filters.space || filters.due) return null;
  return { ...filters, due: 'today', status: 'open' };
}
