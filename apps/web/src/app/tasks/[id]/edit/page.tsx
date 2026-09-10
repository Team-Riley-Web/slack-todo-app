import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTask, listSpaces } from '@tr/task-core';
import { getDb } from '@/db';
import { requireUser } from '@/user';
import { editTaskFormVoid } from '@/actions/tasks';
import { Shell } from '@/components/Shell';

/**
 * The one place a title can be changed.
 *
 * Rendered as a pane over a dimmed backdrop, so it reads as a panel sliding in
 * from the right rather than a page you navigated to. It IS still its own
 * route: the pane is CSS, and the backdrop is a link back to the list. That
 * keeps it working with no client JavaScript, gives it a real URL that can be
 * linked and bookmarked, and means the back button behaves.
 *
 * Still not an inline field in the list: a title must only change through an
 * explicit submission, and a form here cannot be triggered by a stray click
 * while scanning tasks.
 *
 * Every field the Slack modal offers is here, prefilled, so an unchanged
 * submission writes nothing — `editTask` compares against current state.
 */
export default async function EditTaskPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { error } = await searchParams;
  const db = await getDb();

  const task = await getTask(db, id).catch(() => null);
  if (!task) notFound();

  const spaces = await listSpaces(db);

  // datetime-local wants `YYYY-MM-DDTHH:mm` with no zone or seconds.
  const dueValue = task.due_at
    ? task.due_at.toISOString().slice(0, 16)
    : '';

  return (
    <Shell current="/" who={user.name ?? user.slackUserId}>
      {/* The backdrop is a link, so clicking away closes the pane. */}
      <Link className="pane-backdrop" href="/" aria-label="Close" />

      <aside className="pane" aria-label="Edit task">
        <header className="pane-head">
          <h1>Edit task</h1>
          <Link className="pane-close" href="/" aria-label="Close">×</Link>
        </header>
        <p className="muted small">
          Changing the title here is an explicit edit and is recorded in the
          task history against your Slack account.
        </p>

      {error ? <p className="error">{String(error)}</p> : null}

      <form className="stack" action={editTaskFormVoid}>
        <input type="hidden" name="taskId" value={task.id} />

        <label>
          Title
          <input
            type="text"
            name="title"
            required
            defaultValue={task.title}
            aria-label="Task title"
          />
        </label>

        <label>
          Space
          <select name="spaceId" defaultValue={task.space_id}>
            {spaces.map((space) => (
              <option key={space.id} value={space.id}>{space.name}</option>
            ))}
          </select>
        </label>

        <label>
          Status
          <select name="status" defaultValue={task.status}>
            <option value="open">Open</option>
            <option value="waiting">Waiting / blocked</option>
            <option value="completed">Completed</option>
          </select>
        </label>

        <label>
          Assignee Slack ID
          <input
            type="text"
            name="assigneeId"
            defaultValue={task.assignee_id ?? ''}
            placeholder="U01ABCDEF, or leave empty to unassign"
          />
        </label>

        <label>
          Due
          <input type="datetime-local" name="dueAt" defaultValue={dueValue} />
        </label>

        <label>
          Waiting on
          <input
            type="text"
            name="waitingOn"
            defaultValue={task.waiting_on ?? ''}
            placeholder="Only used when the status is waiting"
          />
        </label>

        <label>
          Details
          <textarea name="details" defaultValue={task.details ?? ''} />
        </label>

        <div className="filters">
          <button type="submit" className="primary">Save</button>
          <Link className="btn" href="/">Cancel</Link>
        </div>
      </form>

        <h2>History</h2>
        <TaskHistory taskId={task.id} />
      </aside>
    </Shell>
  );
}

async function TaskHistory({ taskId }: { taskId: string }) {
  const db = await getDb();
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
          <tr><th>When</th><th>What</th><th>Who</th><th>Where</th></tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td>{new Date(row.created_at).toISOString().slice(0, 16).replace('T', ' ')}</td>
              <td>{row.event}</td>
              <td>{row.actor_id ?? '—'}</td>
              <td>{row.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
