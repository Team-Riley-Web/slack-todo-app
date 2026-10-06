import { claimRun, finishRun, releaseRun } from './ledger.js';
import { syncChannelMappings } from './channel-sync.js';
import { buildRunAlert, sendAlert } from './alerts.js';
import {
  DIGEST_LIMIT, getOpenTasks, loadBriefingPlan, postBriefing,
  type JobDeps, type PostResult,
} from './jobs.js';
import { findBriefing, type Briefing } from './routing.js';
import { localMoment, SCHEDULE_ZONE } from './schedule.js';
import type { GroupedTasks } from '@tr/task-core';

export interface JobRunReport {
  /** The briefing's name: `agency`, `personal`, or a Space slug. */
  key: string;
  /** The Monday of the week this run belongs to. */
  occurrence: string;
  /**
   * posted    -- a message went to Slack
   * duplicate -- this week's briefing was already delivered
   * skipped   -- nothing to send, or nowhere to send it
   * failed    -- the post threw; the claim was released
   * unrouted  -- open tasks in a Space no briefing can safely carry
   */
  status: 'posted' | 'duplicate' | 'skipped' | 'failed' | 'unrouted';
  channel?: string;
  taskCount?: number;
  shownCount?: number;
  messageTimestamps?: string[];
  reason?: string;
}

export interface RunReport {
  /** The America/Chicago wall clock the dispatch ran at. */
  localTime: string;
  /** The Monday of the week every briefing in this run is keyed to. */
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
 * Claims this week's briefing, posts, and records what happened.
 *
 * Claim first, post second, record third. Claiming after posting would let two
 * invocations both post before either claimed. The claim is released only when
 * the post THREW, which means nothing reached Slack -- a failure after a
 * successful post keeps the claim, because re-delivering is worse than losing
 * a detail row.
 */
async function runOne(
  deps: JobDeps, briefing: Briefing, week: string, all: GroupedTasks
): Promise<JobRunReport> {
  const { db } = deps;
  const base = {
    key: briefing.name, occurrence: week,
    ...(briefing.channelId ? { channel: briefing.channelId } : {}),
  };
  const claimed = await claimRun(db, briefing.ledgerKey, week);
  if (!claimed) return { ...base, status: 'duplicate' };

  let result: PostResult;
  try {
    result = await postBriefing(deps, briefing, { week, all });
  } catch (error) {
    await releaseRun(db, briefing.ledgerKey, week);
    console.error(
      `[scheduler] ${briefing.name} failed for week of ${week}: ${sanitizeError(error)}`
    );
    return { ...base, status: 'failed', reason: sanitizeError(error) };
  }

  if (!result.posted) {
    await finishRun(db, briefing.ledgerKey, week, 'skipped', {
      briefing: briefing.name,
      reason: result.reason ?? 'nothing posted', taskCount: result.taskCount,
    });
    return {
      ...base, status: 'skipped', reason: result.reason, taskCount: result.taskCount,
    };
  }

  await finishRun(db, briefing.ledgerKey, week, 'posted', {
    briefing: briefing.name,
    channel: briefing.channelId,
    taskCount: result.taskCount,
    shownCount: result.shownCount,
    messageTimestamps: result.messageTimestamps,
    ...(result.truncated ? { truncated: true } : {}),
  });
  return {
    ...base, status: 'posted',
    taskCount: result.taskCount, shownCount: result.shownCount,
    messageTimestamps: result.messageTimestamps,
  };
}

export interface RunWeeklyOptions {
  /** The instant to key the run to. Defaults to now. */
  at?: Date;
  zone?: string;
  /** Run WITHOUT recording anything, for `--dry-run`. */
  rehearsal?: boolean;
}

/**
 * The whole scheduler: post every weekly briefing, report what could not be
 * routed, stop.
 *
 * Vercel Cron fires this once a week. The ledger key is the Monday of the
 * local ISO week, so a Vercel retry, a manual `dispatch`, or a stray second
 * invocation any day that week finds every briefing already claimed and posts
 * nothing. That is the guarantee of one briefing per channel per week.
 *
 * The open tasks are read ONCE and split by briefing, and each Space belongs
 * to at most one briefing (`planBriefings`), so no task can appear in two
 * channels' posts.
 *
 * Briefings are ISOLATED. Each claims its own ledger row and has its own
 * try/catch inside `runOne`, and they run one after another, so a failure in
 * one channel cannot stop the next from being attempted or touch what an
 * earlier one delivered.
 *
 * Deterministic throughout: no model, no ranking beyond the shared query's
 * priority order, no interpretation, and no writes to any task.
 */
export async function runWeeklyDispatch(
  deps: JobDeps, opts: RunWeeklyOptions = {}
): Promise<RunReport> {
  const zone = opts.zone ?? deps.config.timeZone ?? SCHEDULE_ZONE;
  const moment = localMoment(opts.at ?? new Date(), zone);
  const week = moment.week;

  // Channels created since last week get mapped by name first, so a new
  // client channel is briefed this Monday. Best effort: a Slack hiccup or a
  // missing `channels:read` scope must never stop the briefings themselves.
  // A rehearsal reports what it would map and writes nothing.
  if (deps.client.conversations) {
    try {
      const added = await syncChannelMappings(
        deps.db, { conversations: deps.client.conversations }, deps.config,
        { apply: !opts.rehearsal }
      );
      for (const m of added) {
        console.log(`[scheduler] ${opts.rehearsal ? 'would map' : 'mapped'} ` +
          `#${m.channelName} (${m.channelId}) -> ${m.space.name}`);
      }
    } catch (error) {
      console.warn(`[scheduler] channel sync skipped: ${sanitizeError(error)}`);
    }
  }

  const plan = await loadBriefingPlan(deps.db, deps.config);
  const all = await getOpenTasks(deps.db);
  if (all.entries.length >= DIGEST_LIMIT) {
    console.warn(
      `[scheduler] hit the ${DIGEST_LIMIT}-row query cap; ` +
      'some open tasks are not in this week\'s briefings.'
    );
  }

  const results: JobRunReport[] = [];
  for (const briefing of plan.briefings) {
    if (!opts.rehearsal) {
      results.push(await runOne(deps, briefing, week, all));
      continue;
    }
    // A rehearsal must never consume the real occurrence, so it skips the
    // ledger entirely rather than claiming and releasing.
    try {
      const result = await postBriefing(deps, briefing, { week, all });
      results.push({
        key: briefing.name, occurrence: week,
        ...(briefing.channelId ? { channel: briefing.channelId } : {}),
        status: result.posted ? 'posted' : 'skipped',
        reason: result.reason, taskCount: result.taskCount,
        shownCount: result.shownCount, messageTimestamps: result.messageTimestamps,
      });
    } catch (error) {
      results.push({
        key: briefing.name, occurrence: week, status: 'failed', reason: sanitizeError(error),
      });
    }
  }

  // Open work in a Space no briefing can carry is said out loud, never
  // posted somewhere plausible. A Space with nothing open is not news.
  for (const { space, reason } of plan.unrouted) {
    const taskCount = all.entries.filter((e) => e.space.id === space.id).length;
    if (taskCount === 0) continue;
    console.warn(`[scheduler] ${space.name}: ${taskCount} open task(s) not briefed: ${reason}`);
    results.push({ key: space.slug, occurrence: week, status: 'unrouted', taskCount, reason });
  }

  // Tell a person, in Slack, about anything that did not go out. A rehearsal
  // posts nothing anywhere, so it never alerts either.
  if (!opts.rehearsal) {
    const alert = buildRunAlert(results, week, deps.config);
    if (alert) await sendAlert(deps.client, deps.config, alert);
  }

  return {
    localTime: `${moment.date} ${String(moment.hour).padStart(2, '0')}:${
      String(moment.minute).padStart(2, '0')} ${zone}`,
    occurrence: week,
    results,
  };
}

export class UnknownBriefingError extends Error {
  constructor(readonly briefing: string, readonly available: string[]) {
    super(`Unknown briefing "${briefing}"`);
  }
}

/**
 * Runs ONE briefing immediately, ignoring the ledger.
 *
 * The manual test path. It goes through the same `loadBriefingPlan` and
 * `postBriefing` the cron does -- there is no second code path to drift --
 * and deliberately does not claim the week, so a test post at 6am Monday
 * does not consume the briefing the cron delivers an hour later.
 */
export async function runBriefingNow(
  deps: JobDeps, name: string, opts: { at?: Date } = {}
): Promise<PostResult> {
  const plan = await loadBriefingPlan(deps.db, deps.config);
  const briefing = findBriefing(plan, name);
  if (!briefing) {
    throw new UnknownBriefingError(name, plan.briefings.map((b) => b.name));
  }
  const week = localMoment(opts.at ?? new Date(), deps.config.timeZone).week;
  return postBriefing(deps, briefing, { week, all: await getOpenTasks(deps.db) });
}
