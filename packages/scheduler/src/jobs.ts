import type { Db } from '@tr/db';
import {
  isAgencySpace, isPersonalSpace, listOpenTasksBySpace,
  type GroupedTasks, type Space,
} from '@tr/task-core';
import { saveCard } from '@tr/slack-sync';
import type { CardEntry } from '@tr/slack-ui';
import { planTaskMessages } from './messages.js';
import type { SchedulerConfig } from './config.js';

/**
 * `listTasks` caps a result at 500 rows, so the digest asks for the maximum.
 *
 * A workspace that genuinely holds more than 500 open tasks in one half of the
 * split would silently lose the overflow, so `postDigest` checks for the cap
 * and says so in the logs and the run record rather than quietly under-posting.
 */
export const DIGEST_LIMIT = 500;

/**
 * The five recurring Personal habits Hermes owns.
 *
 * They live in the Personal Space like anything else, but Hermes posts and
 * tracks them on its own schedule. Including them here would mean two systems
 * putting the same five checkboxes in the same channel every morning.
 *
 * Matched on the WHOLE title, case-insensitively and trimmed — never as a
 * substring. "Meditate" is excluded; "Meditate with Rachael before the Level
 * 10" is a real one-off task and must still appear. A substring rule would
 * silently swallow it.
 *
 * This is also what "one-time Personal tasks" means in practice: the app has
 * no notion of a recurring task, so excluding the five recurring ones IS the
 * one-time filter.
 */
export const DAILY_ANCHORS: readonly string[] = [
  'Meditate',
  'Exercise',
  'Journal',
  'Cold Exposure',
  'Vocal Warm-Ups',
];

const ANCHOR_SET = new Set(DAILY_ANCHORS.map((t) => t.toLowerCase()));

export function isDailyAnchor(title: string): boolean {
  return ANCHOR_SET.has(title.trim().toLowerCase());
}

/**
 * Drops the Daily Anchors, keeping the grouping and order the shared query
 * produced. A Space left with nothing is dropped rather than posted empty.
 */
export function withoutDailyAnchors(tasks: GroupedTasks): GroupedTasks {
  const keep = (e: { task: { title: string } }) => !isDailyAnchor(e.task.title);
  return {
    entries: tasks.entries.filter(keep),
    groups: tasks.groups
      .map((g) => ({ ...g, entries: g.entries.filter(keep) }))
      .filter((g) => g.entries.length > 0),
  };
}

export interface SlackPoster {
  chat: {
    postMessage: (args: Record<string, unknown>) => Promise<{ ts?: string }>;
  };
}

export interface JobDeps {
  db: Db;
  client: SlackPoster;
  config: SchedulerConfig;
}

/**
 * Every open Agency/business task, grouped by Space.
 *
 * This is `/tasks all` with a Space filter and nothing else: same
 * `listOpenTasksBySpace`, same `status = 'open'` rule, same ordering. Fresh
 * from the database on every call, never a cached digest -- the whole point is
 * that the 8am message reflects the source of truth at 8am.
 */
export function getAllOpenAgencyTasks(
  db: Db, config: SchedulerConfig
): Promise<GroupedTasks> {
  return listOpenTasksBySpace(db, {
    spaceFilter: (space: Space) => isAgencySpace(space, config.personalSpaceKeys),
    limit: DIGEST_LIMIT,
  });
}

/**
 * Every open one-time Personal task, by the same route, minus the Daily
 * Anchors Hermes owns.
 *
 * The exclusion is applied AFTER the shared query rather than pushed into it:
 * `listOpenTasksBySpace` stays the one retrieval path every surface uses, and
 * this is a delivery decision belonging to the morning post, not a new
 * definition of what a Personal task is. `/tasks personal` still shows all
 * five.
 */
export async function getAllOpenPersonalTasks(
  db: Db, config: SchedulerConfig
): Promise<GroupedTasks> {
  return withoutDailyAnchors(await listOpenTasksBySpace(db, {
    spaceFilter: (space: Space) => isPersonalSpace(space, config.personalSpaceKeys),
    limit: DIGEST_LIMIT,
  }));
}

export interface PostResult {
  posted: boolean;
  /** Why nothing went out, when nothing did. */
  reason?: string;
  taskCount: number;
  messageTimestamps: string[];
  /** True when the row cap was hit and tasks may be missing. */
  truncated?: boolean;
}

export interface DigestOptions {
  heading: string;
  channelId: string | null;
  tasks: GroupedTasks;
  /** Recorded on each `slack_cards` row; distinguishes these from `/tasks` cards. */
  viewScope: string;
}

/**
 * Posts one digest, in as many messages as it takes to show every task.
 *
 * Each message is saved as its own card, so the native checkboxes work in all
 * of them exactly as they do on a `/tasks` card -- ticking one in tomorrow's
 * digest completes the task and redraws that message. Nothing here interprets,
 * ranks or filters the tasks beyond the Agency/Personal split.
 */
export async function postDigest(
  deps: JobDeps, opts: DigestOptions
): Promise<PostResult> {
  const { db, client, config } = deps;
  const { entries, groups } = opts.tasks;

  if (!opts.channelId) {
    return {
      posted: false,
      reason: 'no channel configured',
      taskCount: entries.length,
      messageTimestamps: [],
    };
  }

  const truncated = entries.length >= DIGEST_LIMIT;
  if (truncated) {
    console.warn(
      `[scheduler] ${opts.viewScope}: hit the ${DIGEST_LIMIT}-row query cap; ` +
      'some open tasks are not in this digest.'
    );
  }

  const planned = planTaskMessages(opts.heading, groups, {
    timeZone: config.timeZone,
    assigneeLabels: config.assigneeLabels,
  });

  const timestamps: string[] = [];
  for (const message of planned) {
    const posted = await client.chat.postMessage({
      channel: opts.channelId,
      text: message.text,
      blocks: message.blocks,
    });
    if (!posted.ts) continue;
    timestamps.push(posted.ts);
    // An empty digest has no card to keep live, and saving one would create a
    // slack_cards row holding no tasks.
    if (message.entries.length > 0) {
      await saveCard(db, {
        channelId: opts.channelId,
        messageTs: posted.ts,
        entries: message.entries as CardEntry[],
        viewScope: opts.viewScope,
      });
    }
  }

  return {
    posted: true,
    taskCount: entries.length,
    messageTimestamps: timestamps,
    ...(truncated ? { truncated } : {}),
  };
}

export async function postAgencyDailyTasks(deps: JobDeps): Promise<PostResult> {
  return postDigest(deps, {
    heading: 'Agency Tasks — Today',
    channelId: deps.config.agencyChannelId || null,
    tasks: await getAllOpenAgencyTasks(deps.db, deps.config),
    viewScope: 'scheduled:agency-daily',
  });
}

export async function postPersonalDailyTasks(deps: JobDeps): Promise<PostResult> {
  return postDigest(deps, {
    heading: 'Personal Tasks — Today',
    channelId: deps.config.personalChannelId || null,
    tasks: await getAllOpenPersonalTasks(deps.db, deps.config),
    viewScope: 'scheduled:personal-daily',
  });
}
