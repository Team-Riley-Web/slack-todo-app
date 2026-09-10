import type { Db } from '@tr/db';

/**
 * `processed_interactions` exists only to absorb Slack's automatic retries of a
 * delivery it thinks went unacknowledged. Those arrive within seconds, so a row
 * has no value after that — but it was retained forever, so the table would
 * accumulate one row per click indefinitely.
 *
 * Seven days is far beyond any retry window and leaves the rows useful for
 * eyeballing recent interaction volume. Run manually with
 * `pnpm prune-interactions` (NOT `pnpm prune`, which is a pnpm built-in that
 * prunes node_modules).
 *
 * `slack_cards` is deliberately NOT pruned: a card stays clickable for as long
 * as the message exists, so its state is still needed. Its own unbounded field,
 * `rendered_versions`, is capped at write time instead.
 */
export const DEFAULT_RETENTION_DAYS = 7;

export function retentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.INTERACTION_RETENTION_DAYS);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_RETENTION_DAYS;
  return Math.floor(raw);
}

/** Returns how many rows were removed. Safe to run concurrently and repeatedly. */
export async function pruneProcessedInteractions(
  db: Db, days = DEFAULT_RETENTION_DAYS
): Promise<number> {
  const window = Math.max(1, Math.floor(days));
  const { rows } = await db.query<{ channel_id: string }>(
    `DELETE FROM processed_interactions
      WHERE processed_at < now() - ($1 || ' days')::interval
      RETURNING channel_id`,
    [String(window)]
  );
  return rows.length;
}

/**
 * Prunes once now, then on an interval. The timer is unref'd so it never holds
 * the process open, and failures are logged rather than thrown — retention is
 * housekeeping and must not take the app down.
 */
export function startRetentionSweep(
  db: Db, days = DEFAULT_RETENTION_DAYS, everyMs = 12 * 60 * 60 * 1000
): () => void {
  const sweep = async () => {
    try {
      const removed = await pruneProcessedInteractions(db, days);
      if (removed > 0) console.log(`[retention] pruned ${removed} processed interactions`);
    } catch (err) {
      console.error('[retention] sweep failed', err);
    }
  };
  void sweep();
  const timer = setInterval(sweep, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
