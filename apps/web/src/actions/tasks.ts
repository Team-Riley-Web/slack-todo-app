'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { WebClient } from '@slack/web-api';
import {
  parseDueInput, resolveDueChoice, type DueWhen, type Priority, type TaskStatus,
} from '@tr/task-core';
import { getDb } from '@/db';
import { currentUser } from '@/user';
import { timeZone } from '@/lib/env';
import {
  completeTaskOp, reopenTaskOp, moveTaskOp, editTaskOp, createTaskOp,
  postponeToTomorrowOp,
  type OperationDeps, type OperationResult, type CaptureStatus,
} from '@/operations/tasks';

/**
 * Thin wrappers over the operations layer.
 *
 * All they add is the Next-specific parts: resolving the signed-in user,
 * building the deps, and revalidating the pages afterwards. Every rule worth
 * testing lives in `operations/`, which needs no Next runtime.
 */

let slackClient: WebClient | null | undefined;

/**
 * The bot token is optional. Without it the task still changes and only the
 * Slack card redraw is skipped, which is the right behaviour for a deployment
 * that has not been given Slack credentials.
 */
function slack(): WebClient | null {
  if (slackClient === undefined) {
    const token = process.env.SLACK_BOT_TOKEN?.trim();
    slackClient = token ? new WebClient(token) : null;
  }
  return slackClient;
}

async function deps(): Promise<OperationDeps | null> {
  const user = await currentUser();
  if (!user) return null;
  const client = slack();
  return {
    db: await getDb(),
    actorId: user.slackUserId,
    // The Slack card redraw runs after the response, so a click is not held
    // open for a round trip to Slack. A failure there is logged, never shown.
    defer: (work) => after(work),
    slack: client
      ? { chat: { update: (args) => client.chat.update(args as never) } }
      : undefined,
    config: {
      timeZone: timeZone(),
      assigneeLabels: assigneeLabels(),
    },
  };
}

function assigneeLabels(): Record<string, string> {
  const id = process.env.DEFAULT_ASSIGNEE_SLACK_ID?.trim();
  const label = process.env.DEFAULT_ASSIGNEE_LABEL?.trim();
  return id && label ? { [id]: label } : {};
}

const DENIED: OperationResult = { ok: false, error: 'You are not signed in.' };

function refresh(): void {
  // Every list view can contain the task that changed, so refresh them all
  // rather than guessing which one the user is looking at.
  for (const path of ['/', '/waiting', '/history', '/spaces']) {
    revalidatePath(path);
  }
}

export async function completeTaskAction(taskId: string): Promise<OperationResult> {
  const d = await deps();
  if (!d) return DENIED;
  const result = await completeTaskOp(d, taskId);
  refresh();
  return result;
}

export async function reopenTaskAction(taskId: string): Promise<OperationResult> {
  const d = await deps();
  if (!d) return DENIED;
  const result = await reopenTaskOp(d, taskId);
  refresh();
  return result;
}

export async function moveTaskAction(
  taskId: string,
  patch: { spaceId?: string; status?: TaskStatus; waitingOn?: string | null }
): Promise<OperationResult> {
  const d = await deps();
  if (!d) return DENIED;
  const result = await moveTaskOp(d, taskId, patch);
  refresh();
  return result;
}

const DUE_WHENS: readonly DueWhen[] = ['none', 'today', 'tomorrow', 'date'];

/**
 * The due date a create or edit form asked for.
 *
 * Current forms send `dueWhen` (+ `dueDate`, `dueTime`). A page loaded before
 * that change still sends a single `dueAt`, so that is still read -- a form
 * left open across a deploy saves instead of failing.
 */
function dueFromForm(formData: FormData): Date | null {
  const when = String(formData.get('dueWhen') ?? '').trim();
  if ((DUE_WHENS as readonly string[]).includes(when)) {
    return resolveDueChoice({
      when: when as DueWhen,
      date: String(formData.get('dueDate') ?? ''),
      time: String(formData.get('dueTime') ?? ''),
    }, new Date(), timeZone());
  }
  const dueRaw = String(formData.get('dueAt') ?? '').trim();
  return dueRaw.length > 0 ? parseDueInput(dueRaw, timeZone()) : null;
}

/** The Today card's "Tomorrow" button. Changes the due date and nothing else. */
export async function postponeToTomorrowAction(taskId: string): Promise<OperationResult> {
  const d = await deps();
  if (!d) return DENIED;
  const result = await postponeToTomorrowOp(d, taskId);
  refresh();
  return result;
}

/** Called only from the dedicated edit form, never from a list row. */
export async function editTaskFormAction(formData: FormData): Promise<OperationResult> {
  const d = await deps();
  if (!d) return DENIED;

  const taskId = String(formData.get('taskId') ?? '');
  const status = String(formData.get('status') ?? '') as TaskStatus;
  const assignee = String(formData.get('assigneeId') ?? '').trim();
  const waitingOn = String(formData.get('waitingOn') ?? '').trim();
  const details = String(formData.get('details') ?? '');
  // '' is the "No priority" option, which parsePriority reads as null.
  const priority = String(formData.get('priority') ?? '').trim();

  const result = await editTaskOp(d, taskId, {
    title: String(formData.get('title') ?? ''),
    spaceId: String(formData.get('spaceId') ?? '') || undefined,
    status: status || undefined,
    assigneeId: assignee.length > 0 ? assignee : null,
    dueAt: dueFromForm(formData),
    waitingOn: waitingOn.length > 0 ? waitingOn : null,
    details: details.length > 0 ? details : null,
    priority: (priority.length > 0 ? priority : null) as Priority | null,
  });
  refresh();
  revalidatePath(`/tasks/${taskId}/edit`);
  return result;
}

export async function createTaskFormAction(formData: FormData): Promise<OperationResult> {
  const d = await deps();
  if (!d) return DENIED;

  const assignee = String(formData.get('assigneeId') ?? '').trim();
  const status = String(formData.get('status') ?? '').trim();
  const waitingOn = String(formData.get('waitingOn') ?? '').trim();
  const details = String(formData.get('details') ?? '');
  const priority = String(formData.get('priority') ?? '').trim();

  const result = await createTaskOp(d, {
    title: String(formData.get('title') ?? ''),
    spaceSlug: String(formData.get('spaceSlug') ?? ''),
    assigneeId: assignee.length > 0 ? assignee : null,
    dueAt: dueFromForm(formData),
    // Read the same way the edit form reads them, so the two paths agree on
    // what an empty field means: nothing, not an empty string.
    status: (status.length > 0 ? status : null) as CaptureStatus | null,
    waitingOn: waitingOn.length > 0 ? waitingOn : null,
    details: details.length > 0 ? details : null,
    priority: (priority.length > 0 ? priority : null) as Priority | null,
  });
  refresh();
  return result;
}

/**
 * Void-returning wrappers, because a `<form action>` handler must return void.
 *
 * A failure is surfaced by redirecting back with an `?error=` parameter that the
 * page renders, so the whole flow stays server-rendered with no client
 * JavaScript and no silently swallowed error.
 */
export async function createTaskFormVoid(formData: FormData): Promise<void> {
  // The view under the pane, including its filters. Capture returns there on
  // success and reopens over it on failure.
  const returnTo = String(formData.get('returnTo') ?? '/') || '/';
  const result = await createTaskFormAction(formData);
  if (!result.ok) {
    const sep = returnTo.includes('?') ? '&' : '?';
    redirect(
      `${returnTo}${sep}newTask=1&error=${encodeURIComponent(result.error)}`
    );
  }
  redirect(returnTo);
}

export async function editTaskFormVoid(formData: FormData): Promise<void> {
  const taskId = String(formData.get('taskId') ?? '');
  // Where the pane was opened from, so saving returns to that filtered view
  // rather than dumping you on the unfiltered list.
  const returnTo = String(formData.get('returnTo') ?? '/') || '/';
  const result = await editTaskFormAction(formData);
  if (!result.ok) {
    const sep = returnTo.includes('?') ? '&' : '?';
    redirect(
      `${returnTo}${sep}edit=${encodeURIComponent(taskId)}` +
      `&error=${encodeURIComponent(result.error)}`
    );
  }
  redirect(returnTo);
}
