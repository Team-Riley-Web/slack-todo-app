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
/** One assignee menu renders per page, so a fixed id is safe. */
const MENU_ID = 'assignee-menu';

const DUE_OPTIONS: Array<{
  value: TaskFilters['due']; label: string; tone: string;
}> = [
  // Order is the horizon you are asking about: today, then the week, then
  // what slipped, then what was never dated. Overdue led before, which put
  // the exception first and today's work third.
  { value: 'today', label: 'Today', tone: 'today' },
  { value: 'week', label: 'This Week', tone: 'week' },
  { value: 'overdue', label: 'Overdue', tone: 'overdue' },
];
/*
 * "No date" was removed on 2026-09-11 as unused. The `none` bucket itself
 * stays in `parseFilters` and in `listTasks`, so an existing `?due=none` URL
 * still works and the API keeps the filter -- only the pill is gone.
 */

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
         * and the list is filtered on arrival. The menu closes itself via the
         * key on the checkbox below -- see the note there.
         *
         * The open state is a checkbox rather than `details`/`summary`. A
         * `details` has no light dismiss: clicking away leaves it hanging
         * open, because only its own summary can close it. A checkbox can be
         * unchecked by any label pointing at it, so a full-viewport label
         * behind the menu closes it on a click anywhere outside -- still with
         * no JavaScript.
         *
         * The id is fixed because exactly one of these renders per page; two
         * would collide, and the label/checkbox pairing is by id.
         */
        <>
          {/*
            No "Assignee" label. The button already reads "Anyone" or a name,
            which says what it filters; the word beside it was naming a control
            that names itself. The accessible name lives on the checkbox.
          */}
          <span className="menu">
            <input
              /*
               * Remounts on every filter change, which is what closes the menu
               * after you choose a name.
               *
               * The comment above used to say choosing a name closed it,
               * because "following a link re-renders the page". Under the App
               * Router it does not: a Link navigates on the client, React
               * reuses this very input, and a checked box stays checked -- so
               * the menu hung open over the list it had just filtered. A key
               * tied to the current filters forces a fresh element, and a
               * fresh checkbox is unchecked.
               */
              key={JSON.stringify(filters)}
              type="checkbox"
              id={MENU_ID}
              className="menu-state"
              aria-label="Filter by assignee"
            />
            {/* Closes the menu from anywhere outside it. Hidden from screen
                readers: it is a mouse affordance, and Escape or Tab already
                serve the keyboard. */}
            <label className="menu-backdrop" htmlFor={MENU_ID} aria-hidden="true" />
            <label className="menu-button" htmlFor={MENU_ID}>
              <span className="menu-value">
                {/*
                  "Assignee" when nothing is chosen, not "Anyone". The word
                  now has to name the control as well as its value, because
                  the label beside it is gone. A chosen person still shows
                  their own name, which is the state worth seeing.
                */}
                {filters.assignee
                  ? assigneeLabels?.[filters.assignee] ?? filters.assignee
                  : 'Assignee'}
              </span>
              <span className="chevron" aria-hidden="true" />
            </label>
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
          </span>
        </>
      )}

      {active && <Link className="chip" href={path}>Clear</Link>}
    </div>
  );
}
