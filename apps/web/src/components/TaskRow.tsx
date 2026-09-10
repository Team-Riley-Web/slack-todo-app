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
 * The checkbox is a form posting a server action, so the row works before any
 * JavaScript loads — the same reason the Slack card uses a native checkbox.
 *
 * Editing is a LINK to a dedicated form, never an inline field. A title must
 * only change through an explicit, deliberate action, and a form on its own
 * page cannot be triggered by a stray click in a list.
 */
export function TaskRow({
  task, space, showAge, showProvenance, assigneeLabels,
}: TaskRowProps) {
  const done = task.status === 'completed';
  const due = dueLabel(task);
  const who = assigneeName(task, assigneeLabels);

  const meta: React.ReactNode[] = [
    <span key="space">{shortSpaceName(space)}</span>,
  ];
  if (who) meta.push(<span key="who">{who}</span>);
  if (due && !done) {
    meta.push(<span key="due" className={due.tone}>{due.text}</span>);
  }
  if (task.status === 'waiting') {
    meta.push(
      <span key="waiting">
        {task.waiting_on ? `waiting on ${task.waiting_on}` : 'waiting'}
      </span>
    );
  }
  if (showAge) meta.push(<span key="age">{ageLabel(task)} old</span>);
  if (done && task.completed_at) {
    meta.push(
      <span key="completed">
        completed {task.completed_at.toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
        })}
      </span>
    );
  }
  if (showProvenance) {
    meta.push(<span key="src">from {task.source_platform}</span>);
  }

  return (
    <li className={done ? 'task done' : 'task'}>
      <form
        className="tick"
        action={async () => {
          'use server';
          if (done) await reopenTaskAction(task.id);
          else await completeTaskAction(task.id);
        }}
      >
        <input
          type="checkbox"
          className="tick"
          checked={done}
          aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
          onChange={undefined}
          readOnly
        />
        <button type="submit" hidden>
          {done ? 'Reopen' : 'Complete'}
        </button>
      </form>

      <div className="body">
        {/* The title is rendered as text, never as markup. */}
        <span className="title">{task.title}</span>
        <div className="meta">
          {meta.map((node, i) => (
            <span key={i}>{i > 0 ? ' · ' : ''}{node}</span>
          ))}
        </div>
      </div>

      <div className="actions">
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
        <Link className="btn" href={taskEditHref(task)}>Edit</Link>
      </div>
    </li>
  );
}

export function TaskList(props: {
  rows: Array<{ task: Task; space: Space }>;
  empty: string;
  showAge?: boolean;
  showProvenance?: boolean;
  assigneeLabels?: Record<string, string>;
}) {
  if (props.rows.length === 0) {
    return <p className="muted">{props.empty}</p>;
  }
  return (
    <ul className="tasks">
      {props.rows.map(({ task, space }) => (
        <TaskRow
          key={task.id}
          task={task}
          space={space}
          showAge={props.showAge}
          showProvenance={props.showProvenance}
          assigneeLabels={props.assigneeLabels}
        />
      ))}
    </ul>
  );
}
