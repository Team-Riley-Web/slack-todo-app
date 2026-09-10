import { loadCard } from './cards.js';
import { withCardLock } from './lock.js';
import { redrawCard, type CardDeps } from './redraw.js';

export interface SyncResult {
  cards: number;
  failed: number;
}

/**
 * Redraws every recorded Slack card containing this task.
 *
 * Called after a mutation that did not come from Slack — a web edit, an API
 * call — so the card a task was created from never sits there showing stale
 * state.
 *
 * Errors are caught per card and counted, never thrown. The task write has
 * already committed by the time this runs, and a Slack outage must degrade the
 * card rather than lose the change.
 *
 * Each redraw takes the per-card lock, so a sync cannot interleave with a
 * concurrent checkbox toggle on the same message.
 */
export async function syncCardsForTask(
  deps: CardDeps, taskId: string
): Promise<SyncResult> {
  const { rows } = await deps.db.query<{ channel_id: string; message_ts: string }>(
    `SELECT channel_id, message_ts FROM slack_cards
      WHERE $1 = ANY(task_ids) ORDER BY updated_at`,
    [taskId]
  );

  let cards = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await withCardLock(`${row.channel_id}:${row.message_ts}`, async () => {
        const card = await loadCard(deps.db, row.channel_id, row.message_ts);
        if (!card) return;
        await redrawCard(
          deps, row.channel_id, row.message_ts, card.task_ids, card.view_scope
        );
      });
      cards += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[slack-sync] could not redraw ${row.channel_id}/${row.message_ts}`, err
      );
    }
  }

  return { cards, failed };
}
