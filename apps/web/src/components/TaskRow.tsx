import Link from 'next/link';
import { PRIORITY_LABELS, type Priority, type Space, type Task } from '@tr/task-core';
import { completeTaskAction, reopenTaskAction, moveTaskAction } from '@/actions/tasks';
import { ageLabel, dueLabel, shortSpaceName, taskEditHref } from '@/lib/display';

export interface TaskRowProps {
  task: Task;
  space: Space;
  /**
   * Adds the "Waiting on" and "Age" columns, for any list that can contain a
   * blocked task. The two travel together: what a task is stuck on and how
   * long it has been stuck are the same question.
   */
  showWaiting?: boolean;
  /**
   * False on a Space page, where the heading already names the Space and
   * repeating it on every row is the same noise the Slack card had.
   */
  showSpace?: boolean;
  /** The page the row sits on, so Edit opens the pane over THIS view. */
  basePath?: string;
  params?: Record<string, string | string[] | undefined>;
  assigneeLabels?: Record<string, string>;
}

/**
 * The priority cell: a compact tinted pill, or an em dash.
 *
 * An em dash for unprioritized rather than a "None" pill, because the assignee,
 * due and waiting-on cells in this same row already use one for "nothing
 * recorded" — a fourth way of saying empty would be a fourth thing to learn.
 * It also keeps a mostly-unprioritized list quiet, which is the point: a pill
 * that appears on every row stops meaning anything.
 *
 * The label is the bare "P0"; the level's name rides in `title` so the column
 * stays narrow without the meaning being lost.
 */
export function PriorityPill({ priority }: { priority: Priority | null }) {
  if (!priority) return <span className="priority">—</span>;
  return (
    <span className="priority">
      <span
        className={`prio prio-${priority.toLowerCase()}`}
        title={`${priority} — ${PRIORITY_LABELS[priority]}`}
      >
        {priority}
      </span>
    </span>
  );
}

function assigneeName(
  task: Task, labels: Record<string, string> | undefined
): string | null {
  if (!task.assignee_id) return null;
  return labels?.[task.assignee_id] ?? task.assignee_id;
}

/**
 * One task.
 *
 * The completion control is a submit button posting a server action, so the row
 * works with no client JavaScript at all.
 *
 * Editing is a LINK to a dedicated form, never an inline field. A title must
 * only change through an explicit, deliberate action, and a form on its own
 * page cannot be triggered by a stray click in a list.
 */
export function TaskRow({
  task, space, showWaiting, showSpace = true, assigneeLabels,
  basePath = '/', params = {},
}: TaskRowProps) {
  const done = task.status === 'completed';
  const completeHere = async () => {
    'use server';
    await completeTaskAction(task.id);
  };
  const reopenHere = async () => {
    'use server';
    await reopenTaskAction(task.id);
  };
  const due = dueLabel(task);
  const who = assigneeName(task, assigneeLabels);

  return (
    <li
      className={
        [
          'row', 'task',
          done ? 'done' : null,
          // Positional grid: a cell that is not rendered has to come off the
          // template too, or every column after it shifts left. The header
          // above carries the same classes for the same reason.
          showSpace ? null : 'nospace',
          showWaiting ? 'haswait' : null,
        ].filter(Boolean).join(' ')
      }
    >
      {/*
        A submit BUTTON, not a checkbox.
        An input type=checkbox does not submit a form when clicked, and this
        app ships no JavaScript to submit one for it, so the previous version
        could not complete anything at all.
      */}
      <form className="tick" action={done ? reopenHere : completeHere}>
        <button
          type="submit"
          className={done ? 'circle done' : 'circle'}
          aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
          title={done ? 'Reopen' : 'Complete'}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <circle cx="10" cy="10" r="8.5" />
            <path d="M6 10.4l2.6 2.6L14.2 7.4" />
          </svg>
        </button>
      </form>

      {/*
        The title, and nothing under it. Everything that used to ride in a
        grey sub-line here -- the Space, what a task waits on, its age, where
        it came from -- is a column now, or gone.

        One line, clipped: the row stays a fixed height so the tick beside it
        never moves. `title` carries the full text for a hover, and the edit
        pane shows all of it in a field.
      */}
      <span className="title">
        {/* Rendered as text, never as markup. */}
        <Link href={taskEditHref(task, basePath, params)} title={task.title}>
          {task.title}
        </Link>
      </span>

      {/* Immediately beside the title, so an eye running down the list of
          titles catches a P0 without crossing the row. */}
      <PriorityPill priority={task.priority} />

      {showSpace ? (
        <span className="space">{shortSpaceName(space)}</span>
      ) : null}

      {showWaiting ? (
        <>
          {/* Every row in a list that shows this column is waiting, so an
              em dash here means "nothing recorded", the same as it does in
              the assignee and due cells. */}
          <span className="waiting-on">{task.waiting_on ?? '—'}</span>
          <span className="age">{ageLabel(task)}</span>
        </>
      ) : null}

      <span className="assignee">{who ?? '—'}</span>

      <span className={due && !done ? `due ${due.tone}` : 'due'}>
        {done && task.completed_at
          ? task.completed_at.toLocaleDateString('en-US', {
              month: 'short', day: 'numeric', timeZone: 'UTC',
            })
          : due
            ? due.text.replace(/^due /i, '')
            : '—'}
      </span>

      <span className="rowactions">
        {task.status === 'open' && (
          <form
            action={async () => {
              'use server';
              await moveTaskAction(task.id, { status: 'waiting' });
            }}
          >
            <button type="submit" title="Move to waiting">Wait</button>
          </form>
        )}
        {task.status === 'waiting' && (
          <form
            action={async () => {
              'use server';
              await moveTaskAction(task.id, { status: 'open', waitingOn: null });
            }}
          >
            <button type="submit" title="Move back to open">Unblock</button>
          </form>
        )}
      </span>
    </li>
  );
}

export function TaskList(props: {
  rows: Array<{ task: Task; space: Space }>;
  empty: string;
  showWaiting?: boolean;
  showSpace?: boolean;
  basePath?: string;
  params?: Record<string, string | string[] | undefined>;
  assigneeLabels?: Record<string, string>;
}) {
  if (props.rows.length === 0) {
    return <p className="empty">{props.empty}</p>;
  }
  return (
    <ul className="rows">
      {props.rows.map(({ task, space }) => (
        <TaskRow
          key={task.id}
          task={task}
          space={space}
          showWaiting={props.showWaiting}
          showSpace={props.showSpace}
          basePath={props.basePath}
          params={props.params}
          assigneeLabels={props.assigneeLabels}
        />
      ))}
    </ul>
  );
}
