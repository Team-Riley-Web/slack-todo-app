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
  label, count, startOpen = true, createHref, columns = 'tasks', children,
}: {
  label: string;
  count: number;
  startOpen?: boolean;
  /** Renders the "+ Create new task" footer when given. */
  createHref?: string;
  /** Which column headings to show. */
  columns?: 'tasks' | 'spaces' | 'none';
  children: React.ReactNode;
}) {
  return (
    <details className="card" open={startOpen}>
      <summary>
        <span className="chevron" aria-hidden="true" />
        <span className="name">{label}</span>
        <span className="count">{count}</span>
      </summary>

      <div className="card-body">
        {columns === 'tasks' ? (
          <div className="row head" aria-hidden="true">
            <span className="tick" />
            <span className="title">Task</span>
            <span className="assignee">Assignee</span>
            <span className="due">Due date</span>
          </div>
        ) : null}
        {columns === 'spaces' ? (
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
