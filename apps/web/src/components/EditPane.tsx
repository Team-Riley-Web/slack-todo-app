import Link from 'next/link';
import { PaneShell } from '@/components/PaneShell';
import type { Db } from '@tr/db';
import {
  getTask, listSpaces, assigneeChoices, PRIORITIES, priorityChoice, describeDueChoice,
  type Space,
} from '@tr/task-core';
import { timeZone } from '@/lib/env';
import { editTaskFormVoid } from '@/actions/tasks';
import { closeEditHref } from '@/lib/display';
import { SpaceSelect } from '@/components/SpaceSelect';
import { DueField } from '@/components/DueField';

/**
 * The edit form, as a pane over the list that is still rendered behind it.
 *
 * It used to be its own route, which swapped the whole page out — so opening
 * an edit made the list disappear. Now the list page renders this when its
 * `edit` query parameter is set, so the list stays underneath, the URL is
 * still linkable, and the back button still closes the pane. No client
 * JavaScript, and no intercepting routes.
 *
 * Still not an inline field in the list: a title must only change through an
 * explicit submission.
 */
export async function EditPane({
  db, taskId, basePath, params, assigneeLabels,
}: {
  db: Db;
  taskId: string;
  basePath: string;
  params: Record<string, string | string[] | undefined>;
  assigneeLabels: Record<string, string>;
}) {
  const task = await getTask(db, taskId).catch(() => null);
  if (!task) return null;

  const spaces = await listSpaces(db);
  const back = closeEditHref(basePath, params);
  const error = Array.isArray(params.error) ? params.error[0] : params.error;

  // Prefilled in the app's zone, the zone the action reads it back in, so
  // saving the pane unchanged leaves the due date exactly where it was.
  const due = describeDueChoice(task.due_at, new Date(), timeZone());

  /*
   * Assignees are offered by name, never by raw Slack id. Reading
   * "U0BU0V0850Q" off a form and having to know it is you is not a thing to
   * ask of anyone. Ids stay the stored value; only the label is shown.
   */
  // Sorted by name, and including the task's own assignee even when nobody
  // configured a label for them, so saving cannot silently reassign it.
  const knownAssignees = assigneeChoices(
    assigneeLabels, task.assignee_id ? [task.assignee_id] : []
  );

  return (
    /* PaneShell plays the exit animation before the pane goes away. */
    <PaneShell>
      {/* The backdrop is a link, so clicking away closes the pane. */}
      <Link className="pane-backdrop" href={back} aria-label="Close" data-pane-close />

      <aside className="pane" aria-label="Edit task">
        <header className="pane-head">
          <h2>Edit task</h2>
          <Link className="pane-close" href={back} aria-label="Close" data-pane-close>×</Link>
        </header>

        {error ? <p className="error">{String(error)}</p> : null}

        <form className="stack" action={editTaskFormVoid}>
          <input type="hidden" name="taskId" value={task.id} />
          <input type="hidden" name="returnTo" value={back} />

          <label>
            Title
            <input
              type="text" name="title" required
              defaultValue={task.title} aria-label="Task title"
            />
          </label>

          <label>
            Space
            <SpaceSelect
              name="spaceId"
              spaces={spaces as Space[]}
              valueOf={(space) => space.id}
              defaultValue={task.space_id}
              ariaLabel="Space"
            />
          </label>

          <label>
            Status
            <select name="status" defaultValue={task.status}>
              <option value="open">Open</option>
              <option value="waiting">Waiting / blocked</option>
              <option value="completed">Completed</option>
            </select>
          </label>

          {/*
            Priority. Options come from the shared PRIORITIES constant, so this
            select cannot offer a value task-core would reject — and "No
            priority" is a real, common answer rather than an absence, so it is
            an explicit option rather than a blank.
          */}
          <label>
            Priority
            <select name="priority" defaultValue={task.priority ?? ''}>
              <option value="">No priority</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>{priorityChoice(p)}</option>
              ))}
            </select>
          </label>

          <label>
            Assignee
            <select name="assigneeId" defaultValue={task.assignee_id ?? ''}>
              <option value="">Unassigned</option>
              {knownAssignees.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </label>

          <DueField when={due.when} date={due.date} time={due.time} />

          <label>
            Waiting on
            <input
              type="text" name="waitingOn"
              defaultValue={task.waiting_on ?? ''}
              placeholder="Only used when the status is waiting"
            />
          </label>

          <label>
            Details
            <textarea name="details" defaultValue={task.details ?? ''} />
          </label>

          {/*
            Its own class, not `filters`. This row is the form's actions, not a
            toolbar, and it is pinned to the bottom of the pane -- borrowing the
            toolbar's class meant borrowing rules written for a different job.
          */}
          <div className="pane-actions">
            <button type="submit" className="primary">Save</button>
            <Link className="btn" href={back} data-pane-close>Cancel</Link>
          </div>
        </form>

        <h2>History</h2>
        <TaskHistory db={db} taskId={task.id} />
      </aside>
    </PaneShell>
  );
}

async function TaskHistory({ db, taskId }: { db: Db; taskId: string }) {
  const { rows } = await db.query<{
    event: string; actor_id: string | null; source: string; created_at: Date;
  }>(
    `SELECT event, actor_id, source, created_at FROM task_events
      WHERE task_id = $1 ORDER BY created_at DESC, id DESC LIMIT 25`,
    [taskId]
  );

  if (rows.length === 0) return <p className="muted small">No history yet.</p>;

  return (
    <div className="scroll-x">
      <table className="plain">
        <thead>
          <tr><th>When</th><th>What</th><th>Where</th></tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td>{new Date(row.created_at).toISOString().slice(0, 16).replace('T', ' ')}</td>
              <td>{row.event}</td>
              <td>{row.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
