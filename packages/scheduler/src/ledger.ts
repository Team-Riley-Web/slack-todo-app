import type { Db } from '@tr/db';
import type { JobKey } from './schedule.js';

export type RunOutcome = 'claimed' | 'posted' | 'skipped';

export interface RunRecord {
  job_key: string;
  occurrence: string;
  outcome: RunOutcome;
  claimed_at: Date;
  finished_at: Date | null;
  detail: Record<string, unknown> | null;
}

/**
 * Takes an occurrence, or reports that someone else already has it.
 *
 * The primary key does the locking. Two invocations racing -- the 8am tick
 * retried by Vercel, or a manual run alongside the scheduled one -- both reach
 * this INSERT; exactly one gets a row back and the other does nothing. That is
 * the whole guarantee against double-posting, and it lives in the database
 * rather than in a flag on a warm serverless instance, because there is no
 * such thing as one warm instance.
 */
export async function claimRun(
  db: Db, jobKey: JobKey, occurrence: string
): Promise<boolean> {
  const { rows } = await db.query(
    `INSERT INTO scheduled_runs (job_key, occurrence)
     VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING job_key`,
    [jobKey, occurrence]
  );
  return rows.length > 0;
}

/** Marks a claimed occurrence done, with what actually went out. */
export async function finishRun(
  db: Db,
  jobKey: JobKey,
  occurrence: string,
  outcome: Exclude<RunOutcome, 'claimed'>,
  detail: Record<string, unknown> = {}
): Promise<void> {
  await db.query(
    `UPDATE scheduled_runs
        SET outcome = $3, detail = $4::jsonb, finished_at = now()
      WHERE job_key = $1 AND occurrence = $2`,
    [jobKey, occurrence, outcome, JSON.stringify(detail)]
  );
}

/**
 * Gives an occurrence back after a failure, so a later tick inside the grace
 * window can try again.
 *
 * Only safe because it runs when nothing was posted. A failure AFTER a
 * successful `chat.postMessage` must not release the claim -- releasing it
 * there would turn one delivered digest into two.
 */
export async function releaseRun(
  db: Db, jobKey: JobKey, occurrence: string
): Promise<void> {
  await db.query(
    `DELETE FROM scheduled_runs
      WHERE job_key = $1 AND occurrence = $2 AND outcome = 'claimed'`,
    [jobKey, occurrence]
  );
}

/** Most recent runs, newest first. For `pnpm scheduled status`. */
export async function recentRuns(db: Db, limit = 20): Promise<RunRecord[]> {
  const { rows } = await db.query<RunRecord>(
    `SELECT job_key, occurrence::text AS occurrence, outcome,
            claimed_at, finished_at, detail
       FROM scheduled_runs ORDER BY claimed_at DESC LIMIT $1`,
    [Math.max(1, Math.floor(limit))]
  );
  return rows;
}
