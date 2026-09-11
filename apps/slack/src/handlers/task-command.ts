import type { Db } from '@tr/db';
import {
  createTask, parseCapture, resolveSpaceForChannel, type Task,
} from '@tr/task-core';
import { taskCardBlocks, taskCardFallback, slackDate } from '@tr/slack-ui';
import { authorize } from '../auth.js';
import { handleCaptureOpen } from './capture-modal.js';
import { saveCard } from '@tr/slack-sync';
import type { AppConfig } from '../config.js';
import {
  replyPrivately, isCannotPostError, cannotPostHere, type Respond,
} from '../reply.js';

export interface CommandDeps {
  db: Db;
  /**
   * Bolt's response_url sender. Optional because modal submits have none,
   * but for a slash command it is the only reply path that works in a
   * channel this app has not been invited to.
   */
  respond?: Respond;
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
    await replyPrivately(
      deps,
      { channelId: command.channel_id, userId: command.user_id },
      'You are not authorized to create tasks with this app.'
    );
    return { created: null, reason: auth.reason };
  }

  // The single permitted normalization: one outer trim of the raw command text.
  const { title, dueAt, priority, dueFromTitleTime } = parseCapture(command.text ?? '', {
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
    await replyPrivately(
      deps,
      { channelId: command.channel_id, userId: command.user_id },
      'Usage: `/task <task title>` — optionally ending with `due:YYYY-MM-DD`.'
    );
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
    // Lifted out of the text by parseCapture, so `/task P0 Fix checkout` stores
    // a P0 task called "Fix checkout" rather than a title starting with "P0".
    priority,
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

  /*
   * The task is already written at this point, on purpose: capture must not
   * depend on whether the app can post. So a channel it cannot post in is
   * reported, not thrown -- the person hears that the task was saved and how
   * to make cards appear, instead of nothing at all.
   */
  let posted: { ts?: string };
  try {
    posted = await client.chat.postMessage({
      channel: command.channel_id,
      text: taskCardFallback(entries),
      blocks,
    });
  } catch (error) {
    if (!isCannotPostError(error)) throw error;
    await replyPrivately(
      deps,
      { channelId: command.channel_id, userId: command.user_id },
      cannotPostHere(
        `Saved *${task.title}* to *${space.name}*.`,
        command.channel_name
      )
    );
    return { created: task, reason: 'cannot_post_in_channel' };
  }

  if (posted.ts) {
    await db.query(`UPDATE tasks SET source_message_ts = $2 WHERE id = $1`, [task.id, posted.ts]);
    await saveCard(db, { channelId: command.channel_id, messageTs: posted.ts, entries });
  }

  return { created: task };
}
