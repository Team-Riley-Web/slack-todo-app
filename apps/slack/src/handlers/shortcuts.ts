import {
  getTask, listSpaces, moveTask,
  InvalidTaskIdError, TaskNotFoundError, type Space, type Task,
} from '@tr/task-core';
import {
  taskPickerView, parsePickerSubmission,
  type PickerAction, type PickerMeta, type PickerEntry,
} from '@tr/slack-ui';
import { authorize } from '../auth.js';
import { loadCard, redrawCard, withCardLock } from '@tr/slack-sync';
import { editTaskView, type EditMeta } from '@tr/slack-ui';
import type { CheckboxDeps } from './checkbox.js';

export {
  PICKER_CALLBACK_ID, PICKER_BLOCK, PICKER_ACTION,
} from '@tr/slack-ui';

/** Must match the callback_ids in config/slack-app-manifest.yaml. */
export const SHORTCUT_IDS = {
  edit: 'task_edit_shortcut',
  waiting: 'task_waiting_shortcut',
} as const;

/**
 * Task actions in Slack's own "More actions" menu.
 *
 * These are message shortcuts, so they live in the ⋮ menu Slack already puts
 * on every message next to Reply in thread, Forward and Save for later. That
 * keeps the card itself to the checkbox and nothing else.
 *
 * The awkward part a shortcut has to solve: it targets a MESSAGE, not a task.
 * A `/tasks` card can hold many tasks, so with more than one on the card the
 * shortcut asks which -- it never guesses, and never quietly acts on the
 * first one.
 */

export interface ShortcutDeps extends CheckboxDeps {
  client: CheckboxDeps['client'] & {
    views: { open: (args: Record<string, unknown>) => Promise<unknown> };
    chat: CheckboxDeps['client']['chat'] & {
      postEphemeral: (args: Record<string, unknown>) => Promise<unknown>;
    };
  };
}

export type ShortcutOutcome =
  | 'applied' | 'opened_edit' | 'opened_picker'
  | 'unauthorized' | 'unknown_card' | 'no_tasks' | 'not_found';

export async function handleTaskShortcut(
  deps: ShortcutDeps, action: PickerAction, body: Record<string, any>
): Promise<{ outcome: ShortcutOutcome }> {
  const { db, config } = deps;

  const auth = authorize(body as never, config);
  if (!auth.ok) return { outcome: 'unauthorized' };

  const channelId: string | undefined = body.channel?.id;
  const messageTs: string | undefined = body.message?.ts ?? body.message_ts;
  if (!channelId || !messageTs) return { outcome: 'unknown_card' };

  const card = await loadCard(db, channelId, messageTs);
  if (!card || card.task_ids.length === 0) {
    await tell(deps, channelId, auth.userId,
      'That message is not a task card from this app.');
    return { outcome: card ? 'no_tasks' : 'unknown_card' };
  }

  // One task: act now. This is the fast path and the common one.
  if (card.task_ids.length === 1) {
    const taskId = card.task_ids[0]!;
    if (action === 'edit') {
      return openEdit(deps, body, taskId, channelId, messageTs);
    }
    return applyWaiting(deps, body, taskId, channelId, messageTs, auth.userId);
  }

  // Several tasks: ask which one.
  const entries = await entriesFor(deps, card.task_ids);
  if (entries.length === 0) {
    await tell(deps, channelId, auth.userId, 'Those tasks no longer exist.');
    return { outcome: 'not_found' };
  }

  const meta: PickerMeta = { action, channelId, messageTs };
  await deps.client.views.open({
    trigger_id: body.trigger_id,
    view: taskPickerView(meta, entries, {
      timeZone: config.timeZone, assigneeLabels: config.assigneeLabels,
    }),
  });
  return { outcome: 'opened_picker' };
}

/** The picker's submit: apply the chosen action to the chosen task. */
export async function handlePickerSubmission(
  deps: ShortcutDeps, body: Record<string, any>
): Promise<{ outcome: ShortcutOutcome; view?: Record<string, unknown> }> {
  const { db, config } = deps;

  const auth = authorize(body as never, config);
  if (!auth.ok) return { outcome: 'unauthorized' };

  const { meta, taskId } = parsePickerSubmission(body?.view ?? {});
  if (!taskId) return { outcome: 'no_tasks' };

  const card = await loadCard(db, meta.channelId, meta.messageTs);
  // The card is the authority on which tasks this message may touch, so a
  // tampered value cannot reach a task that was never on it.
  if (!card || !card.task_ids.includes(taskId)) return { outcome: 'unknown_card' };

  if (meta.action === 'edit') {
    const [task, spaces] = await Promise.all([
      getTask(db, taskId).catch(() => null),
      listSpaces(db),
    ]);
    if (!task) return { outcome: 'not_found' };

    // Pushed onto the picker, so Back returns to the list rather than
    // dropping the user out of the flow.
    const editMeta: EditMeta = {
      taskId, channelId: meta.channelId, messageTs: meta.messageTs,
    };
    return {
      outcome: 'opened_edit',
      view: editTaskView(task, spaces as Space[], editMeta, {
        timeZone: config.timeZone, assigneeLabels: config.assigneeLabels,
      }),
    };
  }

  return applyWaiting(
    deps, body, taskId, meta.channelId, meta.messageTs, auth.userId
  );
}

async function openEdit(
  deps: ShortcutDeps, body: Record<string, any>,
  taskId: string, channelId: string, messageTs: string
): Promise<{ outcome: ShortcutOutcome }> {
  const [task, spaces] = await Promise.all([
    getTask(deps.db, taskId).catch(() => null),
    listSpaces(deps.db),
  ]);
  if (!task) return { outcome: 'not_found' };

  const meta: EditMeta = { taskId, channelId, messageTs };
  await deps.client.views.open({
    trigger_id: body.trigger_id,
    view: editTaskView(task, spaces as Space[], meta, {
      timeZone: deps.config.timeZone, assigneeLabels: deps.config.assigneeLabels,
    }),
  });
  return { outcome: 'opened_edit' };
}

/**
 * Waiting is a toggle, which is why the menu item is named "Toggle Waiting"
 * rather than "Move to Waiting": one static menu label has to work for a task
 * in either state, and a label that lies about what it does is worse than a
 * slightly technical one.
 */
async function applyWaiting(
  deps: ShortcutDeps, body: Record<string, any>,
  taskId: string, channelId: string, messageTs: string, actorId: string | null
): Promise<{ outcome: ShortcutOutcome }> {
  return withCardLock(`${channelId}:${messageTs}`, async () => {
    const card = await loadCard(deps.db, channelId, messageTs);
    if (!card) return { outcome: 'unknown_card' as const };

    const task = await getTask(deps.db, taskId).catch(() => null);
    if (!task) return { outcome: 'not_found' as const };

    // A completed task is not moved. Unchecking it is the reopen gesture, and
    // this must not become a second way to change completion.
    if (task.status === 'completed') {
      await tell(deps, channelId, actorId,
        'That task is completed. Untick it to reopen it first.');
      return { outcome: 'applied' as const };
    }

    try {
      await moveTask(
        deps.db, taskId,
        task.status === 'waiting'
          ? { status: 'open', waitingOn: null }
          : { status: 'waiting' },
        { id: actorId, source: 'slack' }
      );
    } catch (err) {
      if (!(err instanceof InvalidTaskIdError) && !(err instanceof TaskNotFoundError)) throw err;
      return { outcome: 'not_found' as const };
    }

    await redrawCard(deps, channelId, messageTs, card.task_ids, card.view_scope ?? null);
    return { outcome: 'applied' as const };
  });
}

async function entriesFor(
  deps: ShortcutDeps, taskIds: string[]
): Promise<PickerEntry[]> {
  const spaces = new Map((await listSpaces(deps.db)).map((s: Space) => [s.id, s]));
  const tasks = await Promise.all(
    taskIds.map((id) => getTask(deps.db, id).catch(() => null))
  );
  return tasks.flatMap((task: Task | null) => {
    if (!task) return [];
    const space = spaces.get(task.space_id);
    return space ? [{ task, space }] : [];
  });
}

/** Ephemeral, so an explanation never leaves a message in the channel. */
async function tell(
  deps: ShortcutDeps, channelId: string, userId: string | null, text: string
): Promise<void> {
  if (!userId) return;
  try {
    await deps.client.chat.postEphemeral({ channel: channelId, user: userId, text });
  } catch {
    // A failed explanation must not fail the action it was explaining.
  }
}
