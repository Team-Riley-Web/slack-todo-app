import { moveTask, InvalidTaskIdError, TaskNotFoundError } from '@tr/task-core';
import { authorize } from '../auth.js';
import { claimInteraction, loadCard } from '../cards.js';
import { redrawCard, withCardLock, type CheckboxDeps } from './checkbox.js';

export { WAITING_ACTION_ID } from '@tr/slack-ui';

export async function handleWaitingAction(
  deps: CheckboxDeps, body: Record<string, any>
): Promise<{ outcome: 'applied' | 'noop' | 'unauthorized' | 'unknown_card' }> {
  const { db, config } = deps;

  const auth = authorize(body as never, config);
  if (!auth.ok) return { outcome: 'unauthorized' };

  const action = (body.actions ?? [])[0];
  const channelId: string | undefined = body.container?.channel_id ?? body.channel?.id;
  const messageTs: string | undefined = body.container?.message_ts;
  if (!channelId || !messageTs) return { outcome: 'unknown_card' };

  return withCardLock(`${channelId}:${messageTs}`, async () => {
  const card = await loadCard(db, channelId, messageTs);
  if (!card) return { outcome: 'unknown_card' as const };

  const raw: string = action?.selected_option?.value ?? '';
  const separator = raw.indexOf(':');
  const verb = separator === -1 ? '' : raw.slice(0, separator);
  const taskId = separator === -1 ? '' : raw.slice(separator + 1);
  if ((verb !== 'waiting' && verb !== 'open') || !taskId) return { outcome: 'noop' as const };
  if (!card.task_ids.includes(taskId)) return { outcome: 'noop' as const };

  const fresh = await claimInteraction(db, channelId, messageTs, action?.action_ts ?? '');
  let applied = false;
  if (fresh) {
    try {
      await moveTask(
        db, taskId,
        verb === 'waiting' ? { status: 'waiting' } : { status: 'open', waitingOn: null },
        { id: auth.userId, source: 'slack' }
      );
      applied = true;
    } catch (err) {
      if (!(err instanceof InvalidTaskIdError) && !(err instanceof TaskNotFoundError)) throw err;
    }
  }

  await redrawCard(deps, channelId, messageTs, card.task_ids, card.view_scope ?? null);
  return { outcome: (applied ? 'applied' : 'noop') as 'applied' | 'noop' };
  });
}
