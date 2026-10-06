import type { Db } from '@tr/db';
import {
  findSpaceByQuery, getSpaceForChannel, getTaskCounts, listOpenTasksBySpace,
  listSpaces, listTasks, listWaiting, type Space, type Task,
} from '@tr/task-core';
import {
  taskListBlocks, taskCardFallback, summaryBlocks,
  type CardEntry, type CardGroup,
} from '@tr/slack-ui';
import { authorize } from '../auth.js';
import { saveCard } from '@tr/slack-sync';
import type { AppConfig } from '../config.js';
import type { SlashCommandLike } from './task-command.js';
import { handleMapCommand, isMapCommand } from './map-command.js';
import { handleNewSpaceCommand, parseNewSpaceCommand } from './space-command.js';
import {
  replyPrivately, isCannotPostError, cannotPostHere, type Respond,
} from '../reply.js';

export interface TasksDeps {
  db: Db;
  /** Reaches the user even in a channel this app has not joined. */
  respond?: Respond;
  client: {
    chat: {
      postMessage: (args: Record<string, unknown>) => Promise<{ ts?: string }>;
      postEphemeral: (args: Record<string, unknown>) => Promise<unknown>;
    };
    /** Only `/tasks map` uses this, so it stays optional for other callers. */
    views?: { open: (args: Record<string, unknown>) => Promise<unknown> };
  };
  config: AppConfig;
}

export async function handleTasksCommand(
  deps: TasksDeps, command: SlashCommandLike
): Promise<{ scope: string; count: number }> {
  const { db, client, config } = deps;

  const auth = authorize(
    { team: { id: command.team_id }, user: { id: command.user_id } } as never, config
  );
  if (!auth.ok) {
    await replyPrivately(
      deps,
      { channelId: command.channel_id, userId: command.user_id },
      'You are not authorized to view tasks with this app.'
    );
    return { scope: 'unauthorized', count: 0 };
  }

  const scope = (command.text ?? '').trim().toLowerCase();

  // `/tasks map` opens the channel-to-Space modal. Checked before any Space
  // lookup so the word is never read as a Space search.
  if (isMapCommand(scope)) {
    const result = await handleMapCommand(deps as never, command);
    return { scope: 'map', count: result.outcome === 'opened' ? 1 : 0 };
  }

  // `/tasks new <name>` creates a Space and nothing else. Checked before any
  // Space lookup so the words are never read as a Space search.
  const newSpaceName = parseNewSpaceCommand(command.text);
  if (newSpaceName) {
    const result = await handleNewSpaceCommand(deps as never, command, newSpaceName);
    return { scope: 'new-space', count: result.outcome === 'created' ? 1 : 0 };
  }

  const spaces = new Map((await listSpaces(db)).map((s: Space) => [s.id, s]));
  const toEntries = (tasks: Task[]): CardEntry[] =>
    tasks.flatMap((task) => {
      const space = spaces.get(task.space_id);
      return space ? [{ task, space }] : [];
    });

  /**
   * Bare `/tasks` is channel-aware: from a mapped channel it shows that Space,
   * because that is what someone standing in #client-secure-logic means.
   *
   * From an unmapped channel or a DM it says so, rather than answering with
   * every task in the database. That fallback looked identical to the scoping
   * being broken: you stand in a channel you believe is mapped, ask for its
   * tasks, and get all 43 of them with nothing saying why.
   */
  if (!scope) {
    const context = await getSpaceForChannel(db, command.channel_id);
    if (!context.mapped) {
      await replyPrivately(
        deps,
        { channelId: command.channel_id, userId: command.user_id },
        notMappedHere(command.channel_name)
      );
      return { scope: 'unmapped', count: 0 };
    }

    const entries = toEntries(
      await listTasks(db, { spaceId: context.space.id, actionableOnly: true })
    );
    await postList(deps, command, context.space.name.toUpperCase(), entries, context.space.slug);
    return { scope: context.space.slug, count: entries.length };
  }

  /**
   * `/tasks all` shows every actionable task grouped by Space -- with working
   * checkboxes.
   *
   * This used to show per-Space counts, which read as "Inbox: 1 open" and told
   * you a task existed without letting you do anything about it. Counts are
   * still available as `/tasks summary`, but they are no longer what you get
   * for asking to see your tasks.
   */
  if (scope === 'all') {
    /*
     * Grouped by Space, in the order listSpaces returns, so the same Space
     * never appears twice and the ordering is stable between runs.
     *
     * `listOpenTasksBySpace` is that query and that grouping, lifted into
     * task-core so the scheduled weekly briefings run exactly this and not a
     * second copy of it. `/tasks all` and the Monday posts must never disagree
     * about what is open.
     */
    const { entries, groups } = await listOpenTasksBySpace(db);
    await postGroups(deps, command, 'MY TASKS', groups, entries, 'all');
    return { scope: 'all', count: entries.length };
  }

  // Counts only, no interactive controls, so it stays ephemeral.
  if (scope === 'summary' || scope === 'counts') {
    const counts = await getTaskCounts(db);
    // Native header + section.fields; Slack lays the two columns out itself.
    const blocks = summaryBlocks(counts);
    const fallback = counts.length
      ? `MY TASKS\n${counts
          .map((c) => `${c.space_name.replace(/^Client - /, '')} - ${c.open} open`)
          .join('\n')}`
      : 'MY TASKS\nNothing open.';
    await client.chat.postEphemeral({
      channel: command.channel_id, user: command.user_id,
      text: fallback,
      blocks,
    });
    return { scope: 'summary', count: counts.reduce((n, c) => n + c.open, 0) };
  }

  if (scope === 'waiting' || scope === 'blocked') {
    const entries = toEntries(await listWaiting(db));
    await postList(deps, command, 'WAITING / BLOCKED', entries, 'waiting');
    return { scope: 'waiting', count: entries.length };
  }

  const space = await findSpaceByQuery(db, scope);
  if (!space) {
    await client.chat.postEphemeral({
      channel: command.channel_id, user: command.user_id,
      text:
      `No space matches "${command.text.trim()}".\n` +
      '`/tasks all` shows everything · `/tasks map` sets this channel\'s Space · ' +
      '`/tasks new <name>` creates one.',
    });
    return { scope, count: 0 };
  }

  const entries = toEntries(await listTasks(db, { spaceId: space.id, actionableOnly: true }));
  await postList(deps, command, space.name.toUpperCase(), entries, space.slug);
  return { scope: space.slug, count: entries.length };
}

/**
 * What to say when someone asks a channel for its tasks and the channel is not
 * mapped to a Space. Names the channel, because the usual cause is standing in
 * a client channel nobody ever mapped, and gives the three ways forward.
 * `channelName` arrives from Slack without a leading '#'; a DM sends the
 * literal "directmessage", which is not a channel anyone can map.
 */
export function notMappedHere(channelName: string | undefined): string {
  const isDm = !channelName || channelName === 'directmessage';
  const where = isDm ? 'A direct message' : `*#${channelName}*`;
  return (
    `${where} is not mapped to a Space, so there is no channel list to show.\n\n` +
    (isDm ? '' : '`/space` maps this channel to a Space · ') +
    '`/tasks all` shows every open task · `/tasks <space>` shows one Space.'
  );
}

/**
 * The everything view: several Space groups in one posted message, so a single
 * card holds every task and each checkbox still works.
 */
async function postGroups(
  deps: TasksDeps,
  command: SlashCommandLike,
  heading: string,
  groups: CardGroup[],
  entries: CardEntry[],
  viewScope: string
): Promise<void> {
  const { client, db, config } = deps;

  if (entries.length === 0) {
    await replyPrivately(
      deps,
      { channelId: command.channel_id, userId: command.user_id },
      `*${heading}*\n\nNothing open.`
    );
    return;
  }

  let posted: { ts?: string };
  try {
    posted = await client.chat.postMessage({
      channel: command.channel_id,
      text: `${heading}\n${taskCardFallback(entries)}`,
      blocks: taskListBlocks(groups, {
        timeZone: config.timeZone, assigneeLabels: config.assigneeLabels,
      }),
    });
  } catch (error) {
    if (!isCannotPostError(error)) throw error;
    await replyPrivately(
      deps,
      { channelId: command.channel_id, userId: command.user_id },
      cannotPostHere(`*${heading}* has ${entries.length} task(s).`, command.channel_name)
    );
    return;
  }
  if (posted.ts) {
    await saveCard(db, {
      channelId: command.channel_id, messageTs: posted.ts, entries, viewScope,
    });
  }
}

/**
 * Scoped views are posted, not ephemeral: chat.update cannot rewrite an
 * ephemeral message, and in-place update is the whole interaction model.
 */
async function postList(
  deps: TasksDeps,
  command: SlashCommandLike,
  heading: string,
  entries: CardEntry[],
  viewScope: string
): Promise<void> {
  const { client, db, config } = deps;
  const opts = { timeZone: config.timeZone, assigneeLabels: config.assigneeLabels };

  if (entries.length === 0) {
    await replyPrivately(
      deps,
      { channelId: command.channel_id, userId: command.user_id },
      `*${heading}*\n\nNothing here.`
    );
    return;
  }

  let posted: { ts?: string };
  try {
    posted = await client.chat.postMessage({
      channel: command.channel_id,
      text: `${heading}\n${taskCardFallback(entries)}`,
      blocks: taskListBlocks([{ heading, entries }], opts),
    });
  } catch (error) {
    if (!isCannotPostError(error)) throw error;
    await replyPrivately(
      deps,
      { channelId: command.channel_id, userId: command.user_id },
      cannotPostHere(`*${heading}* has ${entries.length} task(s).`, command.channel_name)
    );
    return;
  }
  if (posted.ts) {
    await saveCard(db, {
      channelId: command.channel_id, messageTs: posted.ts, entries, viewScope,
    });
  }
}
