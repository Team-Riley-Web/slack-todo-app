import type { Db } from '@tr/db';
import {
  createTask, parseCapture, resolveSpaceForChannel, type Task,
} from '@tr/task-core';
import { taskCardBlocks, taskCardFallback, slackDate } from '@tr/slack-ui';
import { authorize } from '../auth.js';
import { handleCaptureOpen } from './capture-modal.js';
import { saveCard } from '@tr/slack-sync';
import type { AppConfig } from '../config.js';

export interface CommandDeps {
  db: Db;
  client: {
    /** Only the bare-`/task` modal needs this, so it stays optional. */
    views?: { open: (args: Record<string, unknown>) => Promise<unknown> };
    chat: {
      postMessage: (args: Record<string, unknown>) => Promise<{ ts?: string }>;
      postEphemeral: (args: Record<string, unknown>) => Promise<unknown>;
    };
  };
  config: AppConfig;
}

export interface SlashCommandLike {
  text: string; channel_id: string; user_id: string; team_id: string;
  /** Present on real payloads; needed by anything that opens a modal. */
  trigger_id?: string;
  /** Slack sends this without a leading '#'. */
  channel_name?: string;
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
  const { title, dueAt, dueFromTitleTime } = parseCapture(command.text ?? '', {
    now: new Date(), timeZone: config.timeZone,
  });
  /**
   * A bare `/task` opens the full capture modal rather than printing the
   * syntax and making you type it again. `/task <title>` is untouched.
   */
  if (!title) {
    if (deps.client.views && command.trigger_id) {
      await handleCaptureOpen(deps as never, command);
      return { created: null, reason: 'opened_modal' };
    }
    await client.chat.postEphemeral({
      channel: command.channel_id, user: command.user_id,
      text: 'Usage: `/task <task title>` — optionally ending with `due:YYYY-MM-DD`.',
    });
    return { created: null, reason: 'empty_title' };
  }

  const space = await resolveSpaceForChannel(db, command.channel_id);
  // A card posted in the channel that routes to this Space does not need to
  // name it: standing in #marketing, "Marketing" is not information. An
  // unmapped channel still shows it, because Inbox there IS worth knowing.
  const mappedHere = !space.is_inbox;
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
  const opts = {
    timeZone: config.timeZone,
    assigneeLabels: config.assigneeLabels,
    showSpace: !mappedHere,
  };
  const blocks = taskCardBlocks(entries, opts);
  const notes: string[] = [];
  if (space.is_inbox) {
    notes.push('This channel is not mapped to a Space, so the task went to Inbox.');
  }
  // A due date inferred from the title is stated outright. The system read
  // something into what you typed, so it says so rather than quietly setting a
  // date you never asked for.
  if (dueFromTitleTime && dueAt) {
    notes.push(`Due set to ${slackDate(dueAt, '{date_short} {time}', config.timeZone)} from the time in the title.`);
  }
  if (notes.length > 0) {
    blocks.push({
      type: 'context',
      // mrkdwn, so the date token renders in each reader's own timezone.
      elements: notes.map((text) => ({ type: 'mrkdwn', text, verbatim: false })),
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
