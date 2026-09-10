import Link from 'next/link';
import { withFilter, type TaskFilters } from '@/data/filters';
import { filterHref } from '@/lib/display';

export interface FilterBarProps {
  path: string;
  filters: TaskFilters;
  assignees?: string[];
  assigneeLabels?: Record<string, string>;
  /** Which controls to show; the history view wants the date range too. */
  show?: Array<'due' | 'assignee' | 'dates'>;
}

const DUE_OPTIONS: Array<{ value: TaskFilters['due']; label: string }> = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'none', label: 'No date' },
];

/**
 * The filter row: due buckets as pills, assignee as a select.
 *
 * What used to be here and is not any more:
 *
 * - **Space chips.** Every Space is one click away in the rail.
 * - **Open / Waiting / Completed pills.** The views already mean that — a
 *   Space page splits into those three sections, and Waiting and Completed
 *   have their own pages.
 * - **A pill per person.** One pill per name does not scale past two people
 *   and reads as clutter at one. It is a select now.
 * - **Search.** Moved to the top right, in the page header.
 *
 * Everything is still a link carrying query parameters, so each filtered view
 * has its own URL, the back button behaves, and no client JavaScript runs.
 */
export function FilterBar({
  path, filters, assignees, assigneeLabels, show,
}: FilterBarProps) {
  const visible = show ?? ['due', 'assignee'];

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

  const active = Object.keys(filters).filter((k) => k !== 'space').length > 0;

  return (
    <div className="filters">
      {visible.includes('due') &&
        DUE_OPTIONS.map((o) => chip('due', o.value, o.label!))}

      {visible.includes('dates') && (
        <form method="get" action={path}>
          {(['space', 'assignee', 'q', 'due'] as const).map((key) =>
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

      <span className="filter-spacer" />

      {visible.includes('assignee') && assignees && assignees.length > 0 && (
        /*
         * A GET form with an auto-submitting select would need JavaScript, so
         * it keeps its own Apply. One extra click, no script.
         */
        <form method="get" action={path} className="assignee-filter">
          {(['space', 'q', 'due', 'from', 'to'] as const).map((key) =>
            filters[key] ? (
              <input key={key} type="hidden" name={key} value={filters[key]} />
            ) : null
          )}
          <label className="small">
            Assignee
            <select name="assignee" defaultValue={filters.assignee ?? ''}>
              <option value="">Anyone</option>
              {assignees.map((id) => (
                <option key={id} value={id}>
                  {assigneeLabels?.[id] ?? id}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Apply</button>
        </form>
      )}

      {active && <Link className="chip" href={path}>Clear</Link>}
    </div>
  );
}
