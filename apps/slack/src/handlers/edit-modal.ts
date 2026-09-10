import type { Db } from '@tr/db';
import {
  editTask, getTask, listSpaces,
  InvalidTaskIdError, TaskNotFoundError, type Space,
} from '@tr/task-core';
import {
  editTaskView, parseEditSubmission, EDIT_BLOCKS, type EditMeta,
} from '@tr/slack-ui';
import { authorize } from '../auth.js';
import { loadCard, redrawCard, withCardLock } from '@tr/slack-sync';
import type { AppConfig } from '../config.js';
import type { CheckboxDeps } from './checkbox.js';

export { EDIT_ACTION_ID, EDIT_CALLBACK_ID } from '@tr/slack-ui';

export interface EditDeps {
  db: Db;
  client: {
    views: { open: (args: Record<string, unknown>) => Promise<unknown> };
    chat: { update: (args: Record<string, unknown>) => Promise<unknown> };
  };
  config: AppConfig;
}

export type OpenOutcome =
  | 'opened' | 'unauthorized' | 'no_task' | 'not_found';

/**
 * Opens the edit modal from the card's overflow.
 *
 * A trigger_id expires 3 seconds after Slack sends it, so this does the minimum
 * before calling views.open: authorize, then two indexed reads in parallel, then
 * open. Nothing slower may be added ahead of the open call.
 */
export async function handleEditOpen(
  deps: EditDeps, body: Record<string, any>
): Promise<{ outcome: OpenOutcome }> {
  const auth = authorize(body as never, deps.config);
  if (!auth.ok) return { outcome: 'unauthorized' };

  const raw: string = body.actions?.[0]?.selected_option?.value ?? '';
  if (!raw.startsWith('edit:')) return { outcome: 'no_task' };
  const taskId = raw.slice('edit:'.length);
  if (!taskId) return { outcome: 'no_task' };

  const [task, spaces] = await Promise.all([
    getTask(deps.db, taskId).catch(() => null),
    listSpaces(deps.db),
  ]);
  if (!task) return { outcome: 'not_found' };

  const meta: EditMeta = {
    taskId,
    channelId: body.container?.channel_id ?? body.channel?.id ?? '',
    messageTs: body.container?.message_ts ?? '',
  };

  await deps.client.views.open({
    trigger_id: body.trigger_id,
    view: editTaskView(task, spaces as Space[], meta, {
      timeZone: deps.config.timeZone,
      assigneeLabels: deps.config.assigneeLabels,
    }),
  });
  return { outcome: 'opened' };
}

export interface SubmissionResult {
  outcome: 'saved' | 'unchanged' | 'unauthorized' | 'invalid' | 'not_found';
  error?: { blockId: string; message: string };
}

/**
 * Applies a modal submission through `editTask` — the only title write path —
 * then redraws the originating card.
 *
 * The redraw goes through withCardLock so a modal save cannot interleave with a
 * concurrent checkbox toggle on the same message.
 */
export async function handleEditSubmission(
  deps: EditDeps, body: Record<string, any>
): Promise<SubmissionResult> {
  const auth = authorize(body as never, deps.config);
  if (!auth.ok) return { outcome: 'unauthorized' };

  const { meta, patch, error } = parseEditSubmission(body.view ?? {});
  if (error) return { outcome: 'invalid', error };
  if (!meta.taskId) {
    return {
      outcome: 'invalid',
      error: { blockId: EDIT_BLOCKS.title, message: 'This task could not be found.' },
    };
  }

  const before = await getTask(deps.db, meta.taskId).catch(() => null);
  if (!before) return { outcome: 'not_found' };

  let changed = false;
  try {
    const after = await editTask(deps.db, meta.taskId, patch, {
      id: auth.userId,
      source: 'slack',
    });
    changed =
      after.title !== before.title ||
      after.space_id !== before.space_id ||
      after.status !== before.status ||
      (after.assignee_id ?? null) !== (before.assignee_id ?? null) ||
      (after.due_at?.getTime() ?? null) !== (before.due_at?.getTime() ?? null) ||
      (after.waiting_on ?? null) !== (before.waiting_on ?? null) ||
      (after.details ?? null) !== (before.details ?? null);
  } catch (err) {
    if (err instanceof InvalidTaskIdError || err instanceof TaskNotFoundError) {
      return { outcome: 'not_found' };
    }
    if (err instanceof Error && /non-empty/.test(err.message)) {
      return {
        outcome: 'invalid',
        error: { blockId: EDIT_BLOCKS.title, message: 'Title cannot be empty.' },
      };
    }
    throw err;
  }

  // Redraw the card the modal was opened from, if it is one we recorded.
  if (meta.channelId && meta.messageTs) {
    const checkboxDeps: CheckboxDeps = {
      db: deps.db,
      client: { chat: deps.client.chat },
      config: deps.config,
    };
    await withCardLock(`${meta.channelId}:${meta.messageTs}`, async () => {
      const card = await loadCard(deps.db, meta.channelId, meta.messageTs);
      if (!card) return;
      await redrawCard(
        checkboxDeps, meta.channelId, meta.messageTs, card.task_ids,
        card.view_scope ?? null
      );
    });
  }

  return { outcome: changed ? 'saved' : 'unchanged' };
}
