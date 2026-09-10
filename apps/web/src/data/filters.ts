import type { DueBucket, TaskStatus } from '@tr/task-core';

const STATUSES: TaskStatus[] = ['open', 'waiting', 'completed'];
const DUE_BUCKETS: DueBucket[] = ['overdue', 'today', 'week', 'none'];

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

  return filters;
}

/** Round-trips through parseFilters. An empty filter set produces ''. */
export function filtersToQuery(filters: TaskFilters): string {
  const params = new URLSearchParams();
  for (const key of ['space', 'status', 'assignee', 'due', 'q', 'from', 'to'] as const) {
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
