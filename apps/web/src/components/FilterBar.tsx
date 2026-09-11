import Link from 'next/link';
import { assigneeChoices } from '@tr/task-core';
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

/**
 * The due buckets, each with a tone.
 *
 * The tones are not decoration, and each borrows a hue the app already uses:
 * overdue the red of overdue due-date text, today the accent blue, this week
 * the green of a completed check, and no date a neutral. So the palette stays
 * the same size -- no colour exists only to tint a pill.
 */
const DUE_OPTIONS: Array<{
  value: TaskFilters['due']; label: string; tone: string;
}> = [
  // Order is the horizon you are asking about: today, then the week, then
  // what slipped, then what was never dated. Overdue led before, which put
  // the exception first and today's work third.
  { value: 'today', label: 'Today', tone: 'today' },
  { value: 'week', label: 'This Week', tone: 'week' },
  { value: 'overdue', label: 'Overdue', tone: 'overdue' },
  { value: 'none', label: 'No date', tone: 'none' },
];

/**
 * The filter row: due buckets as pills, assignee as a dropdown.
 *
 * What used to be here and is not any more:
 *
 * - **Space chips.** Every Space is one click away in the rail.
 * - **Open / Waiting / Completed pills.** The views already mean that — a
 *   Space page splits into those three sections, and Waiting and Completed
 *   have their own pages.
 * - **A pill per person.** One pill per name does not scale past two people
 *   and reads as clutter at one. It is a dropdown.
 * - **Search.** Moved to the top right, in the page header.
 * - **The assignee's Apply button.** See below.
 *
 * Everything is still a link carrying query parameters, so each filtered view
 * has its own URL, the back button behaves, and no client JavaScript runs.
 */
export function FilterBar({
  path, filters, assignees, assigneeLabels, show,
}: FilterBarProps) {
  const visible = show ?? ['due', 'assignee'];
  /*
   * Everyone configured, plus anyone actually assigned a task. Ids in use
   * alone would hide a new teammate until someone had already given them
   * work, which is the wrong way round -- you filter to them BEFORE
   * assigning, to see what they have.
   */
  const people = assigneeChoices(assigneeLabels ?? {}, assignees ?? []);

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

  const dueChip = (o: (typeof DUE_OPTIONS)[number]) => (
    <Link
      key={`due-${o.value}`}
      className={`chip tone-${o.tone}`}
      href={filterHref(path, withFilter(filters, 'due', o.value))}
      aria-current={filters.due === o.value}
    >
      {o.label}
    </Link>
  );

  // A sort is an ordering, not a filter: it narrows nothing, so it does not
  // earn a Clear chip. Space is excluded because the rail owns it.
  const active = Object.keys(filters)
    .filter((k) => !['space', 'sort', 'dir'].includes(k)).length > 0;

  return (
    <div className="filters">
      {visible.includes('due') && DUE_OPTIONS.map(dueChip)}

      {visible.includes('dates') && (
        <form method="get" action={path}>
          {(['space', 'assignee', 'q', 'due', 'sort', 'dir'] as const).map((key) =>
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

      {visible.includes('assignee') && people.length > 0 && (
        /*
         * A dropdown whose options are links, not a select in a form.
         *
         * It was a select plus an Apply button, because a select cannot submit
         * its own form without JavaScript and this app ships none. Picking a
         * name and then having to press Apply is one click too many for a
         * filter, so the options are links instead: choosing one navigates,
         * and the list is filtered on arrival. `details`/`summary` gives the
         * dropdown its open and closed states with no script, and it closes
         * on its own because following a link renders the page afresh.
         */
        <>
          <span className="filter-label">Assignee</span>
          <details className="menu">
            <summary>
              <span className="menu-value">
                {filters.assignee
                  ? assigneeLabels?.[filters.assignee] ?? filters.assignee
                  : 'Anyone'}
              </span>
              <span className="chevron" aria-hidden="true" />
            </summary>
            <ul className="menu-list">
              <li>
                <Link
                  href={filterHref(path, withFilter(filters, 'assignee', undefined))}
                  aria-current={!filters.assignee}
                >
                  Anyone
                </Link>
              </li>
              {people.map(([id, label]) => (
                <li key={id}>
                  <Link
                    href={filterHref(path, withFilter(filters, 'assignee', id))}
                    aria-current={filters.assignee === id}
                  >
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}

      {active && <Link className="chip" href={path}>Clear</Link>}
    </div>
  );
}
