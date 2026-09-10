import type { Db } from '@tr/db';
import type { Task, TaskStatus } from './types.js';
import { assertTaskId, InvalidDueDateError, TaskNotFoundError } from './errors.js';

export interface Actor { id: string | null; source: string }

export interface CreateTaskInput {
  title: string;
  spaceId: string;
  assigneeId?: string | null;
  dueAt?: Date | null;
  sourcePlatform?: string;
  sourceChannelId?: string | null;
  sourceMessageTs?: string | null;
  createdBy?: string | null;
  /** Free-form capture notes. Write-at-create; no update path in Phase 1. */
  details?: string | null;
}

const COLS = `id, title, space_id, list_id, assignee_id, status, due_at, waiting_on,
              details, created_at, completed_at, source_platform,
              source_channel_id, source_message_ts, created_by`;

/**
 * The title is written exactly as given. No trimming, casing, or normalization
 * happens here — the Slack boundary performs the single permitted outer trim.
 */
export async function createTask(db: Db, input: CreateTaskInput): Promise<Task> {
  if (typeof input.title !== 'string' || input.title.length === 0) {
    throw new Error('title is required');
  }
  // Guarded here rather than in each adapter: REST, MCP, and Slack all route
  // through createTask, and an Invalid Date reaches Postgres as a type error.
  if (input.dueAt != null && Number.isNaN(input.dueAt.getTime())) {
    throw new InvalidDueDateError(input.dueAt);
  }
  const { rows } = await db.query<Task>(
    `INSERT INTO tasks (title, space_id, assignee_id, due_at, source_platform,
                        source_channel_id, source_message_ts, created_by, details)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'slack'), $6, $7, $8, $9)
     RETURNING ${COLS}`,
    [
      input.title, input.spaceId, input.assigneeId ?? null, input.dueAt ?? null,
      input.sourcePlatform ?? null, input.sourceChannelId ?? null,
      input.sourceMessageTs ?? null, input.createdBy ?? null,
      input.details ?? null,
    ]
  );
  const task = rows[0]!;
  await logEvent(db, task.id, 'created', {
    id: input.createdBy ?? null,
    source: input.sourcePlatform ?? 'slack',
  });
  return task;
}

export async function getTask(db: Db, id: string): Promise<Task | null> {
  const safe = assertTaskId(id);
  const { rows } = await db.query<Task>(`SELECT ${COLS} FROM tasks WHERE id = $1`, [safe]);
  return rows[0] ?? null;
}

async function requireTask(db: Db, id: string): Promise<Task> {
  const task = await getTask(db, id);
  if (!task) throw new TaskNotFoundError(id);
  return task;
}

/** Idempotent by construction: the UPDATE is a no-op when already completed. */
export async function completeTask(db: Db, id: string, actor: Actor): Promise<Task> {
  const safe = assertTaskId(id);
  await requireTask(db, safe);
  const { rows } = await db.query<{ id: string }>(
    `UPDATE tasks SET status = 'completed', completed_at = now()
      WHERE id = $1 AND status <> 'completed' RETURNING id`,
    [safe]
  );
  if (rows.length > 0) await logEvent(db, safe, 'completed', actor);
  return requireTask(db, safe); // always read back
}

/** Idempotent by construction: the UPDATE is a no-op when already open. */
export async function reopenTask(db: Db, id: string, actor: Actor): Promise<Task> {
  const safe = assertTaskId(id);
  await requireTask(db, safe);
  const { rows } = await db.query<{ id: string }>(
    `UPDATE tasks SET status = 'open', completed_at = NULL
      WHERE id = $1 AND status = 'completed' RETURNING id`,
    [safe]
  );
  if (rows.length > 0) await logEvent(db, safe, 'reopened', actor);
  return requireTask(db, safe);
}

export interface MovePatch {
  spaceId?: string;
  status?: TaskStatus;
  waitingOn?: string | null;
}

/**
 * Moves space and/or status. Deliberately cannot touch `title` — any `title`
 * key present on the patch object is ignored because it is never read.
 */
export async function moveTask(
  db: Db, id: string, patch: MovePatch, actor: Actor
): Promise<Task> {
  const safe = assertTaskId(id);
  const before = await requireTask(db, safe);

  const nextStatus = patch.status ?? before.status;
  const nextSpace = patch.spaceId ?? before.space_id;
  const nextWaitingOn =
    nextStatus === 'waiting' ? (patch.waitingOn ?? before.waiting_on ?? null) : null;
  // completed_at comes from the database clock, as completeTask does — mixing
  // the app clock in here would let two paths disagree under clock skew.
  const keepCompletedAt = nextStatus === 'completed';

  await db.query(
    `UPDATE tasks
        SET space_id = $2, status = $3, waiting_on = $4,
            completed_at = CASE WHEN $5 THEN COALESCE(completed_at, now()) ELSE NULL END
      WHERE id = $1`,
    [safe, nextSpace, nextStatus, nextWaitingOn, keepCompletedAt]
  );

  const changed =
    before.status !== nextStatus ||
    before.space_id !== nextSpace ||
    (before.waiting_on ?? null) !== nextWaitingOn;
  if (changed) {
    await logEvent(db, safe, 'moved', actor, {
      from: { status: before.status, space_id: before.space_id },
      to: { status: nextStatus, space_id: nextSpace, waiting_on: nextWaitingOn },
    });
  }
  return requireTask(db, safe);
}

/**
 * Updates ONLY `details`. Deliberately narrow: it reads no other field off its
 * input, so it can never become a backdoor to the title. `title` remains
 * unwritable by any function in this package.
 */
export async function updateTaskDetails(
  db: Db, id: string, details: string | null, actor: Actor
): Promise<Task> {
  const safe = assertTaskId(id);
  if (details !== null && typeof details !== 'string') {
    throw new Error('details must be a string or null');
  }
  const before = await requireTask(db, safe);
  const next = details === null || details.length === 0 ? null : details;

  await db.query(`UPDATE tasks SET details = $2 WHERE id = $1`, [safe, next]);

  if ((before.details ?? null) !== next) {
    await logEvent(db, safe, 'details', actor, {
      previous_length: before.details?.length ?? 0,
      new_length: next?.length ?? 0,
    });
  }
  return requireTask(db, safe);
}

async function logEvent(
  db: Db, taskId: string, event: string, actor: Actor, detail?: unknown
): Promise<void> {
  await db.query(
    `INSERT INTO task_events (task_id, event, actor_id, source, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [taskId, event, actor.id ?? null, actor.source, detail ? JSON.stringify(detail) : null]
  );
}
