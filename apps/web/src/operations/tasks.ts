import type { Db } from '@tr/db';
import {
  completeTask, createTask, editTask, getTask, moveTask, reopenTask,
  updateTaskDetails, findSpaceExact, InvalidTaskIdError, TaskNotFoundError,
  UnknownSpaceError, InvalidDueDateError, InvalidPriorityError,
  type EditableFields, type Priority, type TaskStatus,
} from '@tr/task-core';
import { syncCardsForTask, type CardDeps } from '@tr/slack-sync';

export type OperationResult =
  | { ok: true; taskId: string }
  | { ok: false; error: string };

/**
 * What a web mutation needs. The Slack client is optional: without it the task
 * still changes and only the card redraw is skipped, which is what happens when
 * the web app runs without a Slack bot token.
 */
export interface OperationDeps {
  db: Db;
  actorId: string;
  slack?: CardDeps['client'];
  config?: { timeZone: string; assigneeLabels?: Record<string, string> };
}

/**
 * Redraws any Slack card showing this task.
 *
 * Deliberately after the write and deliberately swallowing its own errors: the
 * task change has already committed, and a Slack outage must degrade the card
 * rather than fail the user's edit.
 */
async function syncSlack(deps: OperationDeps, taskId: string): Promise<void> {
  if (!deps.slack) return;
  try {
    await syncCardsForTask(
      {
        db: deps.db,
        client: deps.slack,
        config: deps.config ?? { timeZone: 'America/Chicago' },
      },
      taskId
    );
  } catch (err) {
    console.error('[web] Slack card sync failed after a task change', err);
  }
}

/** Translates the domain errors into a message a page can render. */
function describe(err: unknown): string | null {
  if (err instanceof InvalidTaskIdError) return 'That task could not be found.';
  if (err instanceof TaskNotFoundError) return 'That task could not be found.';
  if (err instanceof UnknownSpaceError) return err.message;
  if (err instanceof InvalidDueDateError) return 'That due date could not be read.';
  // Only reachable from a hand-built POST: the selects offer four values and
  // an empty one. Still surfaced as a sentence rather than a 500.
  if (err instanceof InvalidPriorityError) return 'That priority is not one of P0-P3.';
  if (err instanceof Error && /non-empty/.test(err.message)) {
    return 'A task needs a title.';
  }
  return null;
}

async function run(
  deps: OperationDeps,
  taskId: string,
  fn: () => Promise<string>
): Promise<OperationResult> {
  try {
    const id = await fn();
    await syncSlack(deps, id);
    return { ok: true, taskId: id };
  } catch (err) {
    const message = describe(err);
    if (message) return { ok: false, error: message };
    throw err;
  }
}

export function completeTaskOp(deps: OperationDeps, taskId: string): Promise<OperationResult> {
  return run(deps, taskId, async () => {
    const task = await completeTask(deps.db, taskId, {
      id: deps.actorId, source: 'web',
    });
    return task.id;
  });
}

export function reopenTaskOp(deps: OperationDeps, taskId: string): Promise<OperationResult> {
  return run(deps, taskId, async () => {
    const task = await reopenTask(deps.db, taskId, { id: deps.actorId, source: 'web' });
    return task.id;
  });
}

export function moveTaskOp(
  deps: OperationDeps,
  taskId: string,
  patch: { spaceId?: string; status?: TaskStatus; waitingOn?: string | null }
): Promise<OperationResult> {
  return run(deps, taskId, async () => {
    const task = await moveTask(deps.db, taskId, patch, {
      id: deps.actorId, source: 'web',
    });
    return task.id;
  });
}

/**
 * The web title-edit path. Calls `editTask`, the single function permitted to
 * write a title, and is reachable only from an explicit form submission.
 */
export function editTaskOp(
  deps: OperationDeps, taskId: string, patch: EditableFields
): Promise<OperationResult> {
  return run(deps, taskId, async () => {
    const task = await editTask(deps.db, taskId, patch, {
      id: deps.actorId, source: 'web',
    });
    return task.id;
  });
}

/**
 * Statuses a task may be CREATED in.
 *
 * `completed` is deliberately absent, matching the Slack capture modal: capture
 * is for work you intend to do, and a task that is already done is an edit, not
 * a capture. Both surfaces offering the same two keeps the web pane and the
 * Slack modal from drifting -- the divergence that made an identical task come
 * out assigned or unassigned depending on where it was typed.
 */
export const CAPTURE_STATUSES = ['open', 'waiting'] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

export async function createTaskOp(
  deps: OperationDeps,
  input: {
    title: string;
    spaceSlug: string;
    assigneeId?: string | null;
    dueAt?: Date | null;
    status?: CaptureStatus | null;
    waitingOn?: string | null;
    details?: string | null;
    priority?: Priority | null;
  }
): Promise<OperationResult> {
  if (typeof input.title !== 'string' || input.title.trim().length === 0) {
    return { ok: false, error: 'A task needs a title.' };
  }

  const status = input.status ?? 'open';
  if (!(CAPTURE_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: `A task cannot be created as "${status}".` };
  }

  const space = await findSpaceExact(deps.db, input.spaceSlug);
  if (!space) return { ok: false, error: `No Space matches "${input.spaceSlug}".` };

  try {
    const task = await createTask(deps.db, {
      // The single permitted normalization, the same one the Slack command uses.
      title: input.title.trim(),
      spaceId: space.id,
      assigneeId: input.assigneeId ?? null,
      dueAt: input.dueAt ?? null,
      // Validated by task-core; an invalid value throws rather than becoming null.
      priority: input.priority ?? null,
      sourcePlatform: 'web',
      createdBy: deps.actorId,
    });

    /*
     * Status and details go through their own task-core paths rather than
     * being smuggled into createTask, so each change is its own audited event
     * -- exactly what the Slack capture modal does. A task captured as waiting
     * therefore reads as created-then-moved in its history, on both surfaces.
     */
    const actor = { id: deps.actorId, source: 'web' };
    const waitingOn = input.waitingOn?.trim() || null;
    if (status === 'waiting' || waitingOn) {
      await moveTask(deps.db, task.id, { status, waitingOn }, actor);
    }
    if (input.details && input.details.length > 0) {
      await updateTaskDetails(deps.db, task.id, input.details, actor);
    }

    return { ok: true, taskId: task.id };
  } catch (err) {
    const message = describe(err);
    if (message) return { ok: false, error: message };
    throw err;
  }
}

/** Used by the edit form to load current values. */
export function loadTaskForEdit(deps: OperationDeps, taskId: string) {
  return getTask(deps.db, taskId).catch(() => null);
}
