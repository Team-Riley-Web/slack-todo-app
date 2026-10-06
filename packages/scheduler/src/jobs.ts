import { DateTime } from 'luxon';
import type { Db } from '@tr/db';
import {
  listOpenTasksBySpace, listSpaces,
  type GroupedTasks, type TaskGroup,
} from '@tr/task-core';
import { saveCard } from '@tr/slack-sync';
import type { CardEntry } from '@tr/slack-ui';
import { planTaskMessages } from './messages.js';
import type { SchedulerConfig } from './config.js';
import type { ChannelLister } from './channel-sync.js';
import { planBriefings, type Briefing, type BriefingPlan } from './routing.js';

/**
 * `listTasks` caps a result at 500 rows, so the briefings ask for the maximum.
 *
 * A workspace that genuinely holds more than 500 open tasks would silently
 * lose the overflow, so the dispatch checks for the cap and says so in the
 * logs and the run record rather than quietly under-posting.
 */
export const DIGEST_LIMIT = 500;

/**
 * The five recurring Personal habits Hermes owns.
 *
 * They live in the Personal Space like anything else, but Hermes posts and
 * tracks them on its own schedule. Including them here would mean two systems
 * putting the same five checkboxes in the same channel.
 *
 * Matched on the WHOLE title, case-insensitively and trimmed — never as a
 * substring. "Meditate" is excluded; "Meditate with Rachael before the Level
 * 10" is a real one-off task and must still appear. A substring rule would
 * silently swallow it.
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
  /** Present on a real Slack client; lets the run map new channels by name. */
  conversations?: ChannelLister['conversations'];
}

export interface JobDeps {
  db: Db;
  client: SlackPoster;
  config: SchedulerConfig;
}

/**
 * Every open task, grouped by Space -- `/tasks all`, exactly.
 *
 * Same `listOpenTasksBySpace`, same `status = 'open'` rule, same
 * `TASK_ORDER_BY` priority ordering. Read ONCE per dispatch and then split by
 * briefing, so every briefing in a run sees the same snapshot and a task can
 * only ever land in the one briefing its Space belongs to. Fresh from the
 * database on every run, never cached.
 */
export function getOpenTasks(db: Db): Promise<GroupedTasks> {
  return listOpenTasksBySpace(db, { limit: DIGEST_LIMIT });
}

/**
 * Where every Space's tasks go this week, from the live Spaces and the live
 * `channel_space_map` -- the same table `/space` and `/map` write. Read on
 * every run, so a channel mapped on Friday gets its briefing on Monday.
 */
export async function loadBriefingPlan(
  db: Db, config: SchedulerConfig
): Promise<BriefingPlan> {
  const spaces = await listSpaces(db);
  const { rows } = await db.query<{ slack_channel_id: string; space_id: string }>(
    `SELECT slack_channel_id, space_id FROM channel_space_map
      ORDER BY slack_channel_id`
  );
  return planBriefings(
    spaces,
    rows.map((r) => ({ channelId: r.slack_channel_id, spaceId: r.space_id })),
    config
  );
}

/** One briefing's share of the open tasks, in the shared query's order. */
export function tasksForBriefing(
  briefing: Briefing, all: GroupedTasks
): GroupedTasks {
  const ids = new Set(briefing.spaces.map((s) => s.id));
  const keep = (e: { space: { id: string } }) => ids.has(e.space.id);
  const mine: GroupedTasks = {
    entries: all.entries.filter(keep),
    groups: all.groups
      .map((g) => ({ ...g, entries: g.entries.filter(keep) }))
      .filter((g) => g.entries.length > 0),
  };
  return briefing.excludeDailyAnchors ? withoutDailyAnchors(mine) : mine;
}

export interface FocusedGroups {
  groups: TaskGroup[];
  /** Per Space, how many open tasks did not make the cut. */
  hidden: Array<{ name: string; slug: string; count: number }>;
}

/**
 * Keeps the top `top` tasks of each Space and counts the rest.
 *
 * "Top" is the shared query's own order -- priority, then due date, then
 * creation -- so nothing here ranks or interprets. A briefing is for
 * attention: the P0s and the overdue work, not every idea ever captured.
 */
export function focusGroups(groups: TaskGroup[], top: number): FocusedGroups {
  const hidden: FocusedGroups['hidden'] = [];
  const focused = groups.map((g) => {
    if (g.entries.length <= top) return g;
    const space = g.entries[0]!.space;
    hidden.push({
      name: space.name.replace(/^Client\s*-\s*/i, ''),
      slug: space.slug,
      count: g.entries.length - top,
    });
    return { ...g, entries: g.entries.slice(0, top) };
  });
  return { groups: focused, hidden };
}

/** "+12 more in Marketing (`/tasks marketing`) · +3 more in Sales (…)" */
export function hiddenFooter(hidden: FocusedGroups['hidden']): string | undefined {
  if (hidden.length === 0) return undefined;
  return hidden
    .map((h) => `+${h.count} more in ${h.name} (\`/tasks ${h.slug}\`)`)
    .join(' · ');
}

/** "Agency Tasks — Week of Oct 5", from the Monday the week starts. */
export function briefingHeading(briefing: Briefing, week: string): string {
  const label = `Week of ${DateTime.fromISO(week).toFormat('LLL d')}`;
  switch (briefing.kind) {
    case 'agency': return `Agency Tasks — ${label}`;
    case 'personal': return `Personal Tasks — ${label}`;
    // The Space's own heading follows directly, so the title need not name it.
    default: return `Tasks — ${label}`;
  }
}

export interface PostResult {
  posted: boolean;
  /** Why nothing went out, when nothing did. */
  reason?: string;
  /** Open tasks this briefing covers, shown or not. */
  taskCount: number;
  /** How many of those were shown as checkboxes. */
  shownCount: number;
  messageTimestamps: string[];
  /** True when the row cap was hit and tasks may be missing. */
  truncated?: boolean;
}

export interface PostBriefingOptions {
  /** The Monday of the week being briefed, as an ISO date. */
  week: string;
  /** Every open task, from `getOpenTasks`. */
  all: GroupedTasks;
}

/**
 * Posts one briefing to its channel.
 *
 * Read-only on tasks: it renders what the database holds and writes nothing
 * to `tasks`. The only rows it writes are the `slack_cards` that keep each
 * message's checkboxes live -- ticking one completes that task and redraws the
 * message exactly as a `/tasks` card does.
 */
export async function postBriefing(
  deps: JobDeps, briefing: Briefing, opts: PostBriefingOptions
): Promise<PostResult> {
  const { db, client, config } = deps;
  const tasks = tasksForBriefing(briefing, opts.all);
  const taskCount = tasks.entries.length;
  const truncated = opts.all.entries.length >= DIGEST_LIMIT;
  const none = (reason: string): PostResult => ({
    posted: false, reason, taskCount, shownCount: 0, messageTimestamps: [],
  });

  if (!briefing.channelId) return none('no channel configured');
  if (taskCount === 0 && !briefing.postWhenEmpty) return none('nothing open');

  const { groups, hidden } = focusGroups(tasks.groups, config.topPerSpace);
  const planned = planTaskMessages(
    briefingHeading(briefing, opts.week),
    groups,
    { timeZone: config.timeZone, assigneeLabels: config.assigneeLabels },
    hiddenFooter(hidden)
  );

  const timestamps: string[] = [];
  let shownCount = 0;
  for (const message of planned) {
    const posted = await client.chat.postMessage({
      channel: briefing.channelId,
      text: message.text,
      blocks: message.blocks,
    });
    shownCount += message.entries.length;
    if (!posted.ts) continue;
    timestamps.push(posted.ts);
    // An empty briefing has no card to keep live, and saving one would create
    // a slack_cards row holding no tasks.
    if (message.entries.length > 0) {
      await saveCard(db, {
        channelId: briefing.channelId,
        messageTs: posted.ts,
        entries: message.entries as CardEntry[],
        viewScope: `scheduled:weekly-${briefing.kind}`,
      });
    }
  }

  return {
    posted: true,
    taskCount,
    shownCount,
    messageTimestamps: timestamps,
    ...(truncated ? { truncated } : {}),
  };
}
