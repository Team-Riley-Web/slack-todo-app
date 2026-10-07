import Link from 'next/link';
import { PRIORITY_LABELS, type Priority, type Space, type Task } from '@tr/task-core';
import { completeTaskAction, reopenTaskAction, moveTaskAction } from '@/actions/tasks';
import { ageLabel, dueLabel, shortSpaceName, taskEditHref } from '@/lib/display';
import { TickButton } from './TickButton';

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
 * Priority rides in the tick circle, not in a column of its own.
 *
 * A list is scanned left to right, and the leftmost thing on a row was a blank
 * circle while the one signal worth catching first — how urgent this is — sat
 * in the fourth column, past the title. The circle was carrying no information
 * at all, so it is where the priority goes: the ring takes the level's colour
 * and the level's own digit sits inside it.
 *
 * Hover and completion both take the circle back: the digit gives way to the
 * check, because the control's job is still to complete the task, and what it
 * is about to do outranks what it is telling you.
 *
 * Nothing is lost by dropping the column. The full "P0 — Critical" is in the
 * button's title and its accessible name, and the level is still sortable from
 * the "P" in the header above the circles.
 */
function priorityMark(priority: Priority | null): {
  className: string; digit: string | null; label: string | null;
} {
  /* A class even for "none", so a rule can name the plain circle without
     spelling out every level it is not. */
  if (!priority) return { className: 'prio-none', digit: null, label: null };
  return {
    className: `prio-${priority.toLowerCase()}`,
    // "P0" without its P: at 19px the ring holds one glyph, and the colour and
    // the column header both already say which scale this is.
    digit: priority.slice(1),
    label: `${priority} — ${PRIORITY_LABELS[priority]}`,
  };
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
  const mark = priorityMark(task.priority);
  /*
   * Is THIS the row whose task is open in the edit pane?
   *
   * The pane is a URL, `?edit=<id>`, and the row already receives that URL's
   * own params so it can build its link -- so the selected state needs no new
   * prop threaded through five pages and two components. `taskEditHref` drops
   * `edit` when it rebuilds the query, which is why the value survives here
   * unread.
   */
  const editing = Array.isArray(params.edit) ? params.edit[0] : params.edit;
  const selected = editing === task.id;

  return (
    <li
      className={
        [
          'row', 'task',
          done ? 'done' : null,
          selected ? 'selected' : null,
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
        <TickButton
          isDone={done}
          openClass={['circle', mark.className].join(' ')}
          doneClass="circle done"
          prio={task.priority ? task.priority.toLowerCase() : undefined}
          /*
           * The priority rides in the accessible name as well as in the ring,
           * because the ring is a colour and a digit inside a graphic. A
           * reader hears "Complete Buy milk, P0 — Critical", which is the
           * action and the state the column used to carry.
           *
           * Not on a completed row: the digit is not drawn there either, the
           * circle having become the green check.
           */
          label={
            done
              ? `Reopen ${task.title}`
              : `Complete ${task.title}${mark.label ? `, ${mark.label}` : ''}`
          }
          hint={
            done ? 'Reopen' : mark.label ? `${mark.label}. Complete` : 'Complete'
          }
        >
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <circle cx="10" cy="10" r="8.5" />
            {/* Before the check in document order, so the check paints over it
                during the moment both are fading. */}
            {/*
              y is a BASELINE, not a centre. At 11px the cap height is about
              7.9 units of this 20-unit box, so the baseline has to sit half a
              cap below the middle for the digit to look centred: 10 + 3.9.
              `dominant-baseline: central` would say the same thing in one
              word and is the reason this looked high at first -- it is not
              reliable enough across browsers to trust with a glyph this
              small.
            */}
            {!done && mark.digit ? (
              <text className="rank" x="10" y="13.9">{mark.digit}</text>
            ) : null}
            <path d="M6 10.4l2.6 2.6L14.2 7.4" />
          </svg>
        </TickButton>
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
        {/* Rendered as text, never as markup.
            aria-current on the open one, so the selected row is not announced
            by its tint alone -- a reader says "current page" on the task the
            pane beside it is showing. */}
        <Link
          href={taskEditHref(task, basePath, params)}
          title={task.title}
          aria-current={selected ? 'page' : undefined}
        >
          {task.title}
        </Link>
      </span>

      {/* No priority cell. It is the tick circle now -- see priorityMark. */}

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
