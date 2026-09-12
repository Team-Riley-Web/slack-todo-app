import Link from 'next/link';
import type { SortKey } from '@/data/filters';
import type { Sorting } from '@/lib/sort';

/**
 * One section of a task list, as a card.
 *
 * The reference groups tasks into white cards, each with a collapse control,
 * a title, a count, and a table header naming the columns. Rows sit inside.
 * A bare list with a bottom border, which is what this replaced, reads as a
 * different product however it is coloured.
 *
 * `details`/`summary` still does the collapsing, so no client JavaScript is
 * involved.
 */
export function SectionCard({
  label, count, startOpen = true, createHref, columns = 'tasks',
  showSpace = true, showWaiting = false, sorting, headLabel, tone, children,
}: {
  label: string;
  count: number;
  startOpen?: boolean;
  /** Renders the "+ Create new task" footer when given. */
  createHref?: string;
  /** Which column headings to show. */
  columns?: 'tasks' | 'spaces' | 'none';
  /**
   * Must match the `showSpace` given to the rows below. The header is a
   * sibling of the list, not a parent, so it cannot read that from the rows
   * -- and a header one column out of step with its rows is worse than no
   * header at all.
   */
  showSpace?: boolean;
  /** Must match the rows' `showWaiting`, for the same reason. */
  showWaiting?: boolean;
  /** When given, column labels become links that order the list. */
  sorting?: Sorting;
  /** What the first cell of the band says. Defaults to the column's own name. */
  headLabel?: string;
  /** Tints the band so a group reads as Open or Waiting at a glance. */
  tone?: HeadTone;
  children: React.ReactNode;
}) {
  return (
    <details
      className={[
        'card',
        columns === 'spaces' ? 'cols-spaces' : null,
      ].filter(Boolean).join(' ')}
      open={startOpen}
    >
      {/*
       * The tone goes on the summary, not on a band beneath it.
       *
       * On a Space page the summary ALREADY says Open or Waiting, so a second
       * strip repeating the word under it was the redundancy. Tinting the row
       * that carries the word is the same signal with one element instead of
       * two.
       */}
      <summary className={tone ? `summary-${tone}` : undefined}>
        <span className="chevron" aria-hidden="true" />
        <span className="name">{label}</span>
        <span className="count">{count}</span>
      </summary>

      <div className="card-body">
        {/*
          No column header over an empty list. "Task / Assignee / Due date"
          above "Nothing open" labels columns that are not there, and it was
          the thing that made the card look misaligned: three text elements at
          three different left edges, one of them floating over nothing.
        */}
        {columns === 'tasks' && count > 0 ? (
          <ColumnHead
            label={headLabel}
            tone={tone}
            sorting={sorting}
            showSpace={showSpace}
            showWaiting={showWaiting}
          />
        ) : null}
        {columns === 'spaces' && count > 0 ? (
          <div className="row spacerow head" aria-hidden="true">
            <span className="title">Space</span>
            <span className="num">Open</span>
            <span className="num">Waiting</span>
            <span className="num">Done</span>
            {/* Same class as the rows' icon column, so the header lines up
                with it rather than merely happening to share a track. */}
            <span className="iconactions" />
          </div>
        ) : null}
        {children}
        {createHref ? (
          <Link className="create" href={createHref}>+ Create new task</Link>
        ) : null}
      </div>
    </details>
  );
}

/**
 * One column label: plain text, or a link that orders the list by it.
 *
 * A link rather than a button, so each ordering is a URL -- linkable, and the
 * back button undoes a re-sort -- and it needs no JavaScript. The arrow shows
 * on the active column only; every label is clickable, which the hover colour
 * and pointer say without putting a glyph on every column.
 */
function column(
  className: string, key: SortKey, text: string, sorting: Sorting | undefined
) {
  if (!sorting) return <span className={className}>{text}</span>;

  const active = sorting.sort === key;
  const descending = active && sorting.dir === 'desc';
  return (
    <span className={className}>
      <Link
        href={sorting.href(key)}
        className={active ? 'sort active' : 'sort'}
        aria-label={
          active
            ? `${text}, sorted ${descending ? 'descending' : 'ascending'}. Reverse the order`
            : `Sort by ${text}`
        }
      >
        {text}
        {active ? (
          <span className="arrow" aria-hidden="true">{descending ? '↓' : '↑'}</span>
        ) : null}
      </Link>
    </span>
  );
}


export type HeadTone = 'open' | 'waiting';

/**
 * The band above a group of rows.
 *
 * It is the column header AND the group label in one strip, which is the whole
 * point: a card used to stack a "Task / Priority / Assignee / Due date" header
 * directly on top of a "WAITING" band, two grey bars meaning different things.
 * Now the first cell carries the group name -- OPEN or WAITING -- and the rest
 * of the cells stay the sortable column labels they always were.
 *
 * A tint says which group it is without reading the word: the faintest blue
 * for open work, the faintest purple for blocked. Both are far too light to
 * affect the label's contrast, so this is decoration on top of a word rather
 * than colour carrying meaning on its own.
 */
export function ColumnHead({
  label, tone, sorting, showSpace = true, showWaiting = false,
}: {
  label?: string;
  tone?: HeadTone;
  sorting?: Sorting;
  showSpace?: boolean;
  showWaiting?: boolean;
}) {
  return (
    <div
      className={[
        'row', 'head',
        tone ? `head-${tone}` : null,
        label ? 'head-group' : null,
        showSpace ? null : 'nospace',
        showWaiting ? 'haswait' : null,
      ].filter(Boolean).join(' ')}
      /* Plain labels are hidden from screen readers -- read out of a grid that
         is not a real table they are noise. Sort links are controls, and a
         link inside aria-hidden is unreachable. */
      aria-hidden={sorting ? undefined : true}
    >
      {/*
        The tick column's header stays empty. It briefly held a "P" -- the
        priority sort, over the circles that now carry the level -- and one
        stray letter at the left edge of every band was more noise than the
        sort was worth. Ordering by priority is still a URL (`?sort=priority`),
        it simply has no control of its own any more.
      */}
      <span className="tick" />
      {column('title', 'title', label ?? 'Task', sorting)}
      {showSpace ? column('space', 'space', 'Space', sorting) : null}
      {showWaiting ? (
        <>
          {column('waiting-on', 'waiting', 'Waiting on', sorting)}
          {column('age', 'age', 'Age', sorting)}
        </>
      ) : null}
      {column('assignee', 'assignee', 'Assignee', sorting)}
      {column('due', 'due', 'Due date', sorting)}
    </div>
  );
}
