import Link from 'next/link';

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
  showSpace = true, showWaiting = false, children,
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
  children: React.ReactNode;
}) {
  return (
    <details
      className={columns === 'spaces' ? 'card cols-spaces' : 'card'}
      open={startOpen}
    >
      <summary>
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
          <div
            className={[
              'row', 'head',
              showSpace ? null : 'nospace',
              showWaiting ? 'haswait' : null,
            ].filter(Boolean).join(' ')}
            aria-hidden="true"
          >
            <span className="tick" />
            <span className="title">Task</span>
            {showSpace ? <span className="space">Space</span> : null}
            {showWaiting ? (
              <>
                <span className="waiting-on">Waiting on</span>
                <span className="age">Age</span>
              </>
            ) : null}
            <span className="assignee">Assignee</span>
            <span className="due">Due date</span>
          </div>
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
