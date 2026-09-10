import type { Db } from '@tr/db';
import {
  createTask, createSpace, getSpaceForChannel, listSpaces, moveTask,
  updateTaskDetails, type Space, type Task,
} from '@tr/task-core';
import {
  captureTaskView, parseCaptureSubmission, CAPTURE_BLOCKS,
  taskCardBlocks, taskCardFallback, type CaptureMeta,
} from '@tr/slack-ui';
import { saveCard } from '@tr/slack-sync';
import { authorize } from '../auth.js';
import type { AppConfig } from '../config.js';
import type { SlashCommandLike } from './task-command.js';
import { isCannotPostError } from '../reply.js';

export { CAPTURE_CALLBACK_ID, CAPTURE_BLOCKS } from '@tr/slack-ui';

/**
 * A bare `/task` opens the full capture modal.
 *
 * `/task <title>` is unchanged and remains the fast path -- the whole point of
 * this system is that capturing a thought costs one line. This is the other
 * half: when a task needs a Space that is not the channel's, a due date,
 * details, or a client Space that does not exist yet.
 *
 * It replaces a usage message that told you the syntax and then made you type
 * it again.
 */

export interface CaptureDeps {
  db: Db;
  client: {
    views: { open: (args: Record<string, unknown>) => Promise<unknown> };
    chat: {
      postMessage: (args: Record<string, unknown>) => Promise<{ ts?: string }>;
      postEphemeral: (args: Record<string, unknown>) => Promise<unknown>;
    };
  };
  config: AppConfig;
}

export async function handleCaptureOpen(
  deps: CaptureDeps, command: SlashCommandLike
): Promise<{ outcome: 'opened' | 'unauthorized' }> {
  const auth = authorize(
    { team: { id: command.team_id }, user: { id: command.user_id } } as never,
    deps.config
  );
  if (!auth.ok) return { outcome: 'unauthorized' };

  const [spaces, context] = await Promise.all([
    listSpaces(deps.db),
    getSpaceForChannel(deps.db, command.channel_id ?? ''),
  ]);

  const meta: CaptureMeta = {
    channelId: command.channel_id ?? '',
    // The channel's Space is preselected, so the modal agrees with what a
    // one-line /task in the same channel would have done.
    defaultSpaceId: context.space.id,
  };

  await deps.client.views.open({
    trigger_id: command.trigger_id,
    view: captureTaskView(meta, spaces as Space[]),
  });
  return { outcome: 'opened' };
}

export interface CaptureResult {
  created: Task | null;
  spaceCreated: Space | null;
  error?: { blockId: string; message: string };
  reason?: string;
}

export async function handleCaptureSubmission(
  deps: CaptureDeps, body: Record<string, any>
): Promise<CaptureResult> {
  const { db, client, config } = deps;

  const auth = authorize(body as never, config);
  if (!auth.ok) {
    return { created: null, spaceCreated: null, reason: auth.reason };
  }

  const parsed = parseCaptureSubmission(body?.view ?? {});
  if (parsed.error) {
    return { created: null, spaceCreated: null, error: parsed.error };
  }

  // A typed name wins over the picker, and creating it is idempotent -- the
  // same client name twice returns the existing Space rather than failing.
  let spaceCreated: Space | null = null;
  let spaceId = parsed.spaceId;
  if (parsed.newSpaceName) {
    const result = await createSpace(db, parsed.newSpaceName);
    if (!result.ok || !result.space) {
      return {
        created: null,
        spaceCreated: null,
        error: {
          blockId: CAPTURE_BLOCKS.newSpace,
          message: result.error ?? 'Could not create that Space.',
        },
      };
    }
    spaceId = result.space.id;
    if (!result.existed) spaceCreated = result.space;
  }
  if (!spaceId) {
    return {
      created: null,
      spaceCreated: null,
      error: { blockId: CAPTURE_BLOCKS.space, message: 'Choose a Space.' },
    };
  }

  const task = await createTask(db, {
    title: parsed.title,
    spaceId,
    assigneeId: parsed.assigneeId ?? config.defaultAssigneeId,
    dueAt: parsed.dueAt,
    sourcePlatform: 'slack',
    sourceChannelId: parsed.meta.channelId,
    createdBy: auth.userId,
  });

  const actor = { id: auth.userId, source: 'slack' };
  // Status and details go through their own task-core paths rather than being
  // smuggled into createTask, so each change is its own audited event.
  if (parsed.status === 'waiting') {
    await moveTask(db, task.id, { status: 'waiting' }, actor);
  }
  if (parsed.details) {
    await updateTaskDetails(db, task.id, parsed.details, actor);
  }

  const spaces = await listSpaces(db);
  const space = (spaces as Space[]).find((s) => s.id === spaceId)!;
  const fresh = { ...task, status: parsed.status } as Task;
  const entries = [{ task: fresh, space }];

  const channel = parsed.meta.channelId || auth.userId;
  if (!channel) return { created: task, spaceCreated };

  const context = await getSpaceForChannel(db, parsed.meta.channelId);
  const blocks = taskCardBlocks(entries, {
    timeZone: config.timeZone,
    assigneeLabels: config.assigneeLabels,
    // Same rule as a one-line capture: the channel that routes here does not
    // need the Space named on the row.
    showSpace: !(context.mapped && context.space.id === spaceId),
  });

  if (spaceCreated) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Created the Space *${spaceCreated.name}*.`,
      }],
    } as never);
  }

  /*
   * A view_submission carries no response_url, so there is no reply path that
   * bypasses channel membership here. The task is still kept: capture must
   * not depend on whether the app can post. The failure is logged rather than
   * thrown so the submit completes, and the web UI shows the task either way.
   */
  let posted: { ts?: string };
  try {
    posted = await client.chat.postMessage({
      channel, text: taskCardFallback(entries), blocks,
    });
  } catch (error) {
    if (!isCannotPostError(error)) throw error;
    console.error(
      `[slack] created task ${task.id} but cannot post in channel ${channel};` +
      ' invite the app to that channel for cards to appear',
      error
    );
    return { created: fresh, spaceCreated };
  }
  if (posted.ts) {
    await db.query(`UPDATE tasks SET source_message_ts = $2 WHERE id = $1`, [
      task.id, posted.ts,
    ]);
    await saveCard(db, { channelId: channel, messageTs: posted.ts, entries });
  }

  return { created: fresh, spaceCreated };
}
