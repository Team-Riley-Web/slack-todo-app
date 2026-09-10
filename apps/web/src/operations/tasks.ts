import type { Db } from '@tr/db';
import {
  completeTask, createTask, editTask, getTask, moveTask, reopenTask,
  findSpaceExact, InvalidTaskIdError, TaskNotFoundError, UnknownSpaceError,
  InvalidDueDateError, type EditableFields, type TaskStatus,
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

export async function createTaskOp(
  deps: OperationDeps,
  input: {
    title: string;
    spaceSlug: string;
    assigneeId?: string | null;
    dueAt?: Date | null;
  }
): Promise<OperationResult> {
  if (typeof input.title !== 'string' || input.title.trim().length === 0) {
    return { ok: false, error: 'A task needs a title.' };
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
      sourcePlatform: 'web',
      createdBy: deps.actorId,
    });
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
