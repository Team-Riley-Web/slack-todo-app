import Link from 'next/link';
import type { Space } from '@tr/task-core';
import { withFilter, type TaskFilters } from '@/data/filters';
import { filterHref, shortSpaceName } from '@/lib/display';

export interface FilterBarProps {
  path: string;
  filters: TaskFilters;
  spaces: Space[];
  assignees?: string[];
  assigneeLabels?: Record<string, string>;
  /** Which controls to show; the waiting and history views want different sets. */
  show?: Array<'space' | 'status' | 'assignee' | 'due' | 'search' | 'dates'>;
}

const DUE_OPTIONS: Array<{ value: TaskFilters['due']; label: string }> = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'none', label: 'No date' },
];

const STATUS_OPTIONS: Array<{ value: TaskFilters['status']; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'completed', label: 'Completed' },
];

/**
 * Filters as links carrying query parameters.
 *
 * Every filtered view therefore has its own URL: shareable, bookmarkable, and
 * the back button behaves. The narrowing happens in SQL, not by hiding rows
 * that were already sent to the browser.
 */
export function FilterBar({
  path, filters, spaces, assignees, assigneeLabels, show,
}: FilterBarProps) {
  const visible = show ?? ['space', 'status', 'assignee', 'due', 'search'];
  const chip = (
    key: keyof TaskFilters, value: string | undefined, label: string
  ) => (
    <Link
      key={`${key}-${value ?? 'any'}`}
      className="chip"
      href={filterHref(path, withFilter(filters, key, value))}
      aria-current={filters[key] === value || (!filters[key] && !value)}
    >
      {label}
    </Link>
  );

  const active = Object.keys(filters).length > 0;

  return (
    <div className="filters">
      {visible.includes('search') && (
        <form method="get" action={path}>
          {/* Carry the other filters through the search submission. */}
          {(['space', 'status', 'assignee', 'due', 'from', 'to'] as const).map((key) =>
            filters[key] ? (
              <input key={key} type="hidden" name={key} value={filters[key]} />
            ) : null
          )}
          <input
            type="search"
            name="q"
            defaultValue={filters.q ?? ''}
            placeholder="Search titles"
            aria-label="Search task titles"
          />
          <button type="submit">Search</button>
        </form>
      )}

      {visible.includes('dates') && (
        <form method="get" action={path}>
          {(['space', 'assignee', 'q'] as const).map((key) =>
            filters[key] ? (
              <input key={key} type="hidden" name={key} value={filters[key]} />
            ) : null
          )}
          <label className="small">
            From <input type="date" name="from" defaultValue={filters.from ?? ''} />
          </label>
          <label className="small">
            To <input type="date" name="to" defaultValue={filters.to ?? ''} />
          </label>
          <button type="submit">Apply</button>
        </form>
      )}

      {visible.includes('space') && (
        <>
          {chip('space', undefined, 'All spaces')}
          {spaces.map((space) => chip('space', space.slug, shortSpaceName(space)))}
        </>
      )}

      {visible.includes('status') &&
        STATUS_OPTIONS.map((o) => chip('status', o.value, o.label))}

      {visible.includes('due') &&
        DUE_OPTIONS.map((o) => chip('due', o.value, o.label))}

      {visible.includes('assignee') && assignees && assignees.length > 0 && (
        <>
          {chip('assignee', undefined, 'Anyone')}
          {assignees.map((id) =>
            chip('assignee', id, assigneeLabels?.[id] ?? id)
          )}
        </>
      )}

      {active && (
        <Link className="chip" href={path}>Clear</Link>
      )}
    </div>
  );
}
