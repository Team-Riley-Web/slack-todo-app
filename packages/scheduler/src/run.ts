import type { Db } from '@tr/db';
import { claimRun, finishRun, releaseRun } from './ledger.js';
import {
  postAgencyDailyTasks, postPersonalDailyTasks,
  type JobDeps, type PostResult,
} from './jobs.js';
import { localMoment, SCHEDULE_ZONE, type JobKey } from './schedule.js';

export interface JobRunReport {
  key: JobKey;
  occurrence: string;
  /**
   * posted    -- a message went to Slack
   * duplicate -- this occurrence was already delivered today
   * skipped   -- nothing to send it to
   * failed    -- the post threw; the claim was released
   */
  status: 'posted' | 'duplicate' | 'skipped' | 'failed';
  taskCount?: number;
  messageTimestamps?: string[];
  reason?: string;
}

export interface RunReport {
  /** The America/Chicago wall clock the dispatch ran at. */
  localTime: string;
  /** The local date both posts are keyed to. */
  occurrence: string;
  results: JobRunReport[];
}

/**
 * Never let a Slack error carry a token into the logs.
 *
 * Slack's own errors are short codes (`channel_not_found`, `not_in_channel`),
 * but a transport failure can surface a URL or a header, so the message is
 * truncated and anything token-shaped is masked rather than trusted.
 */
export function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/xox[abprs]-[A-Za-z0-9-]+/g, 'xox***')
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .slice(0, 200);
}

/**
 * Claims today's occurrence, posts, and records what happened.
 *
 * Claim first, post second, record third. Claiming after posting would let two
 * invocations both post before either claimed. The claim is released only when
 * the post THREW, which means nothing reached Slack -- a failure after a
 * successful post keeps the claim, because re-delivering is worse than losing
 * a detail row.
 */
async function runOne(
  db: Db,
  deps: JobDeps,
  key: JobKey,
  occurrence: string,
  post: (deps: JobDeps) => Promise<PostResult>
): Promise<JobRunReport> {
  const claimed = await claimRun(db, key, occurrence);
  if (!claimed) return { key, occurrence, status: 'duplicate' };

  let result: PostResult;
  try {
    result = await post(deps);
  } catch (error) {
    await releaseRun(db, key, occurrence);
    console.error(`[scheduler] ${key} failed for ${occurrence}: ${sanitizeError(error)}`);
    return { key, occurrence, status: 'failed', reason: sanitizeError(error) };
  }

  if (!result.posted) {
    await finishRun(db, key, occurrence, 'skipped', {
      reason: result.reason ?? 'nothing posted', taskCount: result.taskCount,
    });
    return {
      key, occurrence, status: 'skipped',
      reason: result.reason, taskCount: result.taskCount,
    };
  }

  await finishRun(db, key, occurrence, 'posted', {
    taskCount: result.taskCount,
    messageTimestamps: result.messageTimestamps,
    ...(result.truncated ? { truncated: true } : {}),
  });
  return {
    key, occurrence, status: 'posted',
    taskCount: result.taskCount, messageTimestamps: result.messageTimestamps,
  };
}

export interface RunDailyOptions {
  /** The instant to key the run to. Defaults to now. */
  at?: Date;
  zone?: string;
  /** Run WITHOUT recording anything, for `--dry-run`. */
  rehearsal?: boolean;
}

/**
 * The whole scheduler: post the Agency list, post the Personal list, stop.
 *
 * There is no clock to consult and nothing to decide. Vercel Cron fires this
 * once a day and everything it fires is due by definition -- the hourly
 * dispatcher that used to ask "is anything due?" is gone, along with the
 * reason for it. What made the old design hourly was the EOS reminders, which
 * needed several times of day; Hermes owns those now.
 *
 * The two posts are ISOLATED. Each claims its own ledger row, each has its own
 * try/catch inside `runOne`, and Agency is awaited before Personal starts, so
 * an Agency failure cannot stop the Personal post from being attempted and a
 * Personal failure cannot touch what Agency already delivered.
 *
 * Deterministic throughout: no model, no ranking, no interpretation. The tasks
 * are whatever the database holds at the moment this runs.
 */
export async function runDailyDispatch(
  deps: JobDeps, opts: RunDailyOptions = {}
): Promise<RunReport> {
  const zone = opts.zone ?? deps.config.timeZone ?? SCHEDULE_ZONE;
  const moment = localMoment(opts.at ?? new Date(), zone);
  const results: JobRunReport[] = [];

  const run = async (
    key: JobKey, post: (d: JobDeps) => Promise<PostResult>
  ): Promise<void> => {
    if (opts.rehearsal) {
      // A rehearsal must never consume the real occurrence, so it skips the
      // ledger entirely rather than claiming and releasing.
      try {
        const result = await post(deps);
        results.push({
          key, occurrence: moment.date,
          status: result.posted ? 'posted' : 'skipped',
          reason: result.reason, taskCount: result.taskCount,
          messageTimestamps: result.messageTimestamps,
        });
      } catch (error) {
        results.push({
          key, occurrence: moment.date, status: 'failed', reason: sanitizeError(error),
        });
      }
      return;
    }
    results.push(await runOne(deps.db, deps, key, moment.date, post));
  };

  await run('agency-daily', postAgencyDailyTasks);
  await run('personal-daily', postPersonalDailyTasks);

  return {
    localTime: `${moment.date} ${String(moment.hour).padStart(2, '0')}:${
      String(moment.minute).padStart(2, '0')} ${zone}`,
    occurrence: moment.date,
    results,
  };
}

/**
 * Runs ONE of the two posts immediately, ignoring the ledger.
 *
 * The manual test path. It calls the same `postAgencyDailyTasks` /
 * `postPersonalDailyTasks` the cron calls -- there is no second code path to
 * drift -- and deliberately does not claim an occurrence, so testing the
 * Agency post at noon does not consume tomorrow morning's delivery.
 */
export function runJobNow(deps: JobDeps, key: JobKey): Promise<PostResult> {
  return key === 'agency-daily'
    ? postAgencyDailyTasks(deps)
    : postPersonalDailyTasks(deps);
}
