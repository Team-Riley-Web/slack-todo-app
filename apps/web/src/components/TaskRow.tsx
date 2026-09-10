import Link from 'next/link';
import type { Space, Task } from '@tr/task-core';
import { completeTaskAction, reopenTaskAction, moveTaskAction } from '@/actions/tasks';
import { ageLabel, dueLabel, shortSpaceName, taskEditHref } from '@/lib/display';

export interface TaskRowProps {
  task: Task;
  space: Space;
  /** The waiting view shows age and what a task is blocked on. */
  showAge?: boolean;
  /** History shows where a task came from and when it finished. */
  showProvenance?: boolean;
  /**
   * False on a Space page, where the heading already names the Space and
   * repeating it on every row is the same noise the Slack card had.
   */
  showSpace?: boolean;
  assigneeLabels?: Record<string, string>;
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
  task, space, showAge, showProvenance, showSpace = true, assigneeLabels,
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

  const meta: React.ReactNode[] = showSpace
    ? [<span key="space">{shortSpaceName(space)}</span>]
    : [];
  // Assignee and due date have their own columns now, so they are not
  // repeated in the sub-line under the title.
  if (task.status === 'waiting') {
    meta.push(
      <span key="waiting">
        {task.waiting_on ? `waiting on ${task.waiting_on}` : 'waiting'}
      </span>
    );
  }
  if (showAge) meta.push(<span key="age">{ageLabel(task)} old</span>);
  if (showProvenance) {
    meta.push(<span key="src">from {task.source_platform}</span>);
  }

  return (
    <li className={done ? 'row task done' : 'row task'}>
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

      <span className="title">
        {/* Rendered as text, never as markup. */}
        <Link href={taskEditHref(task)}>{task.title}</Link>
        {meta.length > 0 ? (
          <span className="meta">
            {meta.map((node, i) => (
              <span key={i}>{i > 0 ? ' · ' : ''}{node}</span>
            ))}
          </span>
        ) : null}
      </span>

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
  showAge?: boolean;
  showProvenance?: boolean;
  showSpace?: boolean;
  assigneeLabels?: Record<string, string>;
}) {
  if (props.rows.length === 0) {
    return <p className="muted">{props.empty}</p>;
  }
  return (
    <ul className="rows">
      {props.rows.map(({ task, space }) => (
        <TaskRow
          key={task.id}
          task={task}
          space={space}
          showAge={props.showAge}
          showProvenance={props.showProvenance}
          showSpace={props.showSpace}
          assigneeLabels={props.assigneeLabels}
        />
      ))}
    </ul>
  );
}
