import type { Db } from '@tr/db';
import {
  completeTask, getTask, reopenTask, listSpaces,
  InvalidTaskIdError, TaskNotFoundError, type Space, type Task,
} from '@tr/task-core';
import { taskCardBlocks, taskCardFallback, type CardEntry } from '@tr/slack-ui';
import { authorize } from '../auth.js';
import { claimInteraction, loadCard, saveCard } from '../cards.js';
import type { AppConfig } from '../config.js';

export interface CheckboxDeps {
  db: Db;
  client: { chat: { update: (args: Record<string, unknown>) => Promise<unknown> } };
  config: AppConfig;
}

export type ToggleOutcome =
  | 'applied' | 'noop' | 'duplicate' | 'unauthorized' | 'unknown_card';

interface SelectedOption { value?: string }

/**
 * The docs are inconsistent about where checkbox selections live: the state
 * payload documents `selected_options`, while the checkboxes reference example
 * shows `options`. Read the documented location first, then fall back.
 * An empty array is a genuine deselect-all and must not be read as absence.
 */
export function readSelectedValues(
  body: Record<string, any>, blockId: string, actionId: string
): string[] {
  const fromState = body?.state?.values?.[blockId]?.[actionId]?.selected_options;
  const action = (body?.actions ?? []).find(
    (a: Record<string, unknown>) => a.action_id === actionId
  );
  const chosen: SelectedOption[] | undefined =
    fromState ?? action?.selected_options ?? action?.options;
  if (!Array.isArray(chosen)) return [];
  return chosen.map((o) => o?.value).filter((v): v is string => typeof v === 'string');
}

export async function handleCheckboxToggle(
  deps: CheckboxDeps, body: Record<string, any>
): Promise<{ outcome: ToggleOutcome }> {
  const { db, config } = deps;

  const auth = authorize(body as never, config);
  if (!auth.ok) return { outcome: 'unauthorized' };

  const action = (body.actions ?? [])[0];
  const channelId: string | undefined = body.container?.channel_id ?? body.channel?.id;
  const messageTs: string | undefined = body.container?.message_ts;
  const blockId: string = action?.block_id ?? '';
  const actionId: string = action?.action_id ?? '';
  if (!channelId || !messageTs) return { outcome: 'unknown_card' };

  const card = await loadCard(db, channelId, messageTs);
  if (!card) return { outcome: 'unknown_card' };

  const fresh = await claimInteraction(db, channelId, messageTs, action?.action_ts ?? '');

  const selected = new Set(readSelectedValues(body, blockId, actionId));
  const actor = { id: auth.userId, source: 'slack' };
  let applied = false;

  if (fresh) {
    for (const taskId of card.task_ids) {
      const wasRendered = card.rendered_state[taskId] === true;
      const nowSelected = selected.has(taskId);
      if (wasRendered === nowSelected) continue; // this checkbox did not move
      try {
        if (nowSelected) await completeTask(db, taskId, actor);
        else await reopenTask(db, taskId, actor);
        applied = true;
      } catch (err) {
        if (!(err instanceof InvalidTaskIdError) && !(err instanceof TaskNotFoundError)) throw err;
      }
    }
  }

  await redrawCard(deps, channelId, messageTs, card.task_ids, card.view_scope ?? null);

  if (!fresh) return { outcome: 'duplicate' };
  return { outcome: applied ? 'applied' : 'noop' };
}

/** Reads every task back from the database and rewrites the same message. */
export async function redrawCard(
  deps: CheckboxDeps,
  channelId: string,
  messageTs: string,
  taskIds: string[],
  viewScope: string | null
): Promise<void> {
  const { db, client, config } = deps;
  const spaces = new Map((await listSpaces(db)).map((s: Space) => [s.id, s]));

  const entries: CardEntry[] = [];
  for (const id of taskIds) {
    const task: Task | null = await getTask(db, id).catch(() => null);
    const space = task ? spaces.get(task.space_id) : undefined;
    if (task && space) entries.push({ task, space });
  }

  const opts = { timeZone: config.timeZone, assigneeLabels: config.assigneeLabels };
  await client.chat.update({
    channel: channelId,
    ts: messageTs,
    text: taskCardFallback(entries),
    blocks: taskCardBlocks(entries, opts),
  });
  await saveCard(db, { channelId, messageTs, entries, viewScope });
}
