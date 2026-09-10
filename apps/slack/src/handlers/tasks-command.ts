import type { Db } from '@tr/db';
import {
  findSpaceByQuery, getSpaceForChannel, getTaskCounts, listSpaces, listTasks,
  listWaiting, type Space, type Task,
} from '@tr/task-core';
import { taskListBlocks, taskCardFallback, type CardEntry } from '@tr/slack-ui';
import { authorize } from '../auth.js';
import { saveCard } from '../cards.js';
import type { AppConfig } from '../config.js';
import type { SlashCommandLike } from './task-command.js';

export interface TasksDeps {
  db: Db;
  client: {
    chat: {
      postMessage: (args: Record<string, unknown>) => Promise<{ ts?: string }>;
      postEphemeral: (args: Record<string, unknown>) => Promise<unknown>;
    };
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
    await client.chat.postEphemeral({
      channel: command.channel_id, user: command.user_id,
      text: 'You are not authorized to view tasks with this app.',
    });
    return { scope: 'unauthorized', count: 0 };
  }

  const scope = (command.text ?? '').trim().toLowerCase();
  const spaces = new Map((await listSpaces(db)).map((s: Space) => [s.id, s]));
  const toEntries = (tasks: Task[]): CardEntry[] =>
    tasks.flatMap((task) => {
      const space = spaces.get(task.space_id);
      return space ? [{ task, space }] : [];
    });

  /**
   * Bare `/tasks` is channel-aware: from a mapped channel it shows that Space,
   * because that is what someone standing in #client-secure-logic means. From an
   * unmapped channel or a DM there is no such context, so it shows the
   * cross-Space summary. `/tasks all` forces the summary from anywhere.
   */
  if (!scope) {
    const context = await getSpaceForChannel(db, command.channel_id);
    if (context.mapped) {
      const entries = toEntries(
        await listTasks(db, { spaceId: context.space.id, actionableOnly: true })
      );
      await postList(deps, command, context.space.name.toUpperCase(), entries, context.space.slug);
      return { scope: context.space.slug, count: entries.length };
    }
  }

  // Summary view — no interactive controls, so it stays ephemeral.
  if (!scope || scope === 'all' || scope === 'summary') {
    const counts = await getTaskCounts(db);
    const lines = counts.map((c) => {
      const label = c.space_name.replace(/^Client - /, '');
      const waiting = c.waiting > 0 ? `  (${c.waiting} waiting)` : '';
      return `${label} — ${c.open}${waiting}`;
    });
    const text = lines.length
      ? `*MY TASKS*\n\n${lines.join('\n')}`
      : '*MY TASKS*\n\nNothing open.';
    await client.chat.postEphemeral({
      channel: command.channel_id, user: command.user_id,
      text,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
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
      text: `No space matches "${command.text.trim()}". Try \`/tasks\` for the summary.`,
    });
    return { scope, count: 0 };
  }

  const entries = toEntries(await listTasks(db, { spaceId: space.id, actionableOnly: true }));
  await postList(deps, command, space.name.toUpperCase(), entries, space.slug);
  return { scope: space.slug, count: entries.length };
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
    await client.chat.postEphemeral({
      channel: command.channel_id, user: command.user_id,
      text: `*${heading}*\n\nNothing here.`,
    });
    return;
  }

  const posted = await client.chat.postMessage({
    channel: command.channel_id,
    text: `${heading}\n${taskCardFallback(entries)}`,
    blocks: taskListBlocks([{ heading, entries }], opts),
  });
  if (posted.ts) {
    await saveCard(db, {
      channelId: command.channel_id, messageTs: posted.ts, entries, viewScope,
    });
  }
}
