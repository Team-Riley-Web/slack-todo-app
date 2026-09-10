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
  /** The page the row sits on, so Edit opens the pane over THIS view. */
  basePath?: string;
  params?: Record<string, string | string[] | undefined>;
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

  // Space, assignee and due date all have their own columns now, so none of
  // them is repeated in the sub-line under the title. What is left there is
  // the per-view detail no column carries.
  const meta: React.ReactNode[] = [];
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
    <li
      className={
        [
          'row', 'task',
          done ? 'done' : null,
          // Positional grid: with no Space cell the row needs the template
          // that has no Space track, and so does the header above it.
          showSpace ? null : 'nospace',
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

      <span className="title">
        {/* Rendered as text, never as markup. */}
        <Link href={taskEditHref(task, basePath, params)}>{task.title}</Link>
        {showSpace || meta.length > 0 ? (
          <span className="meta">
            {/*
              The Space appears twice on purpose, and CSS shows exactly one:
              the column below on a wide screen, this sub-line on a phone.
              A phone has no room for a Space track without squeezing titles
              to four lines, and hiding the column outright would make the
              phone the one screen that cannot tell you which Space a task is
              in. The separator lives inside this span so it disappears with
              it -- otherwise the desktop would show a leading " · ".
            */}
            {showSpace ? (
              <span className="space-inline">
                {shortSpaceName(space)}{meta.length > 0 ? ' · ' : ''}
              </span>
            ) : null}
            {meta.map((node, i) => (
              <span key={i}>{i > 0 ? ' · ' : ''}{node}</span>
            ))}
          </span>
        ) : null}
      </span>

      {showSpace ? (
        <span className="space">{shortSpaceName(space)}</span>
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
  showAge?: boolean;
  showProvenance?: boolean;
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
          showAge={props.showAge}
          showProvenance={props.showProvenance}
          showSpace={props.showSpace}
          basePath={props.basePath}
          params={props.params}
          assigneeLabels={props.assigneeLabels}
        />
      ))}
    </ul>
  );
}
