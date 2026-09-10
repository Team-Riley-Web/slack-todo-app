import type { Db } from '@tr/db';
import {
  createTask, parseCapture, resolveSpaceForChannel, type Task,
} from '@tr/task-core';
import { taskCardBlocks, taskCardFallback } from '@tr/slack-ui';
import { authorize } from '../auth.js';
import { saveCard } from '@tr/slack-sync';
import type { AppConfig } from '../config.js';

export interface CommandDeps {
  db: Db;
  client: {
    chat: {
      postMessage: (args: Record<string, unknown>) => Promise<{ ts?: string }>;
      postEphemeral: (args: Record<string, unknown>) => Promise<unknown>;
    };
  };
  config: AppConfig;
}

export interface SlashCommandLike {
  text: string; channel_id: string; user_id: string; team_id: string;
}

export async function handleTaskCommand(
  deps: CommandDeps, command: SlashCommandLike
): Promise<{ created: Task | null; reason?: string }> {
  const { db, client, config } = deps;

  const auth = authorize(
    { team: { id: command.team_id }, user: { id: command.user_id } } as never, config
  );
  if (!auth.ok) {
    await client.chat.postEphemeral({
      channel: command.channel_id, user: command.user_id,
      text: 'You are not authorized to create tasks with this app.',
    });
    return { created: null, reason: auth.reason };
  }

  // The single permitted normalization: one outer trim of the raw command text.
  const { title, dueAt } = parseCapture(command.text ?? '', {
    now: new Date(), timeZone: config.timeZone,
  });
  if (!title) {
    await client.chat.postEphemeral({
      channel: command.channel_id, user: command.user_id,
      text: 'Usage: `/task <task title>` — optionally ending with `due:YYYY-MM-DD`.',
    });
    return { created: null, reason: 'empty_title' };
  }

  const space = await resolveSpaceForChannel(db, command.channel_id);
  const task = await createTask(db, {
    title,
    spaceId: space.id,
    assigneeId: config.defaultAssigneeId,
    dueAt,
    sourcePlatform: 'slack',
    sourceChannelId: command.channel_id,
    createdBy: command.user_id,
  });

  const entries = [{ task, space }];
  const opts = { timeZone: config.timeZone, assigneeLabels: config.assigneeLabels };
  const blocks = taskCardBlocks(entries, opts);
  if (space.is_inbox) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'plain_text',
        text: 'This channel is not mapped to a Space, so the task went to Inbox.',
        emoji: true,
      }],
    } as never);
  }

  const posted = await client.chat.postMessage({
    channel: command.channel_id,
    text: taskCardFallback(entries),
    blocks,
  });

  if (posted.ts) {
    await db.query(`UPDATE tasks SET source_message_ts = $2 WHERE id = $1`, [task.id, posted.ts]);
    await saveCard(db, { channelId: command.channel_id, messageTs: posted.ts, entries });
  }

  return { created: task };
}
