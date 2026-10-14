import type { Db } from '@tr/db';
import {
  createTask, findSpaceExact, getInboxSpace, parseCapture, resolveDueChoice,
  describeDueChoice, InvalidDueDateError, InvalidPriorityError, DEFAULT_TIME_ZONE,
  type DueWhen,
} from '@tr/task-core';

/**
 * POST /api/capture -- quick capture for an Apple Shortcut, so "Hey Siri,
 * add task" files a task without opening anything.
 *
 *   Authorization: Bearer <CAPTURE_TOKEN>
 *   { "text": "P1 Call Neil about the renewal", "due": "today", "space": "Sales" }
 *
 * `text` is read exactly like Slack's `/task`: a leading P0-P3 is the
 * priority, a trailing `due:YYYY-MM-DD` or a clock time is the due date. Two
 * additions suit dictation: `due` may be "today", "tomorrow", "none" or a
 * date (a Shortcut can offer them as a menu), and a spoken trailing "due
 * today" / "due tomorrow" is understood too -- only with the word "due", so
 * a task called "Plan for tomorrow" keeps its whole name. `space` is optional; without
 * it the task goes to Inbox, the same as a capture from an unmapped channel.
 *
 * The answer is ONE plain sentence, because the Shortcut speaks it back:
 * "Added Call Neil about the renewal to Sales, due today."
 *
 * Its own token, so the phone holding it can be cut off without touching
 * MCP or the REST API. An unset token denies everything.
 */
export function authorizeCapture(
  authorization: string | null, env: NodeJS.ProcessEnv = process.env
): boolean {
  const secret = env.CAPTURE_TOKEN?.trim();
  if (!secret) return false;
  const offered = (authorization ?? '').replace(/^Bearer\s+/i, '');
  if (offered.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i += 1) {
    diff |= secret.charCodeAt(i) ^ offered.charCodeAt(i);
  }
  return diff === 0;
}

const say = (status: number, sentence: string) =>
  new Response(sentence, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

const SPOKEN_DUE = /\s+due\s+(today|tomorrow)[.!]?\s*$/i;

function dueWhenFrom(value: unknown): { when: DueWhen; date?: string } | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim().toLowerCase();
  if (v === 'today' || v === 'tomorrow' || v === 'none') return { when: v };
  if (v === 'no date' || v === 'no due date') return { when: 'none' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { when: 'date', date: v };
  return null;
}

export async function handleCaptureRequest(
  request: Request,
  opts: { getDb: () => Promise<Db>; env?: NodeJS.ProcessEnv; now?: Date }
): Promise<Response> {
  const env = opts.env ?? process.env;
  if (!authorizeCapture(request.headers.get('authorization'), env)) {
    return say(401, 'That shortcut is not authorized to add tasks.');
  }

  // JSON from a Shortcut's "Request Body: JSON", or the bare text as a body.
  let body: Record<string, unknown> = {};
  const raw = await request.text();
  try {
    const parsed = JSON.parse(raw) as unknown;
    body = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : { text: raw };
  } catch {
    body = { text: raw };
  }

  const timeZone = env.DEFAULT_TIMEZONE?.trim() || DEFAULT_TIME_ZONE;
  const now = opts.now ?? new Date();
  let text = typeof body.text === 'string' ? body.text : '';
  let due = dueWhenFrom(body.due);
  const spoken = SPOKEN_DUE.exec(text);
  if (spoken) {
    text = text.slice(0, spoken.index);
    due ??= { when: spoken[1]!.toLowerCase() as DueWhen };
  }

  const capture = parseCapture(text, { now, timeZone });
  if (!capture.title) return say(400, 'I did not catch a task. Try again.');

  const db = await opts.getDb();
  const spaceName = typeof body.space === 'string' ? body.space.trim() : '';
  const space = spaceName ? await findSpaceExact(db, spaceName) : await getInboxSpace(db);
  if (!space) return say(400, `There is no Space called ${spaceName}.`);

  const dueAt = due ? resolveDueChoice(due, now, timeZone) : capture.dueAt;
  try {
    const task = await createTask(db, {
      title: capture.title,
      spaceId: space.id,
      assigneeId: env.DEFAULT_ASSIGNEE_SLACK_ID?.trim() || null,
      dueAt,
      priority: capture.priority,
      sourcePlatform: 'siri',
    });
    const where = space.name.replace(/^Client - /, '');
    const choice = describeDueChoice(task.due_at, now, timeZone);
    const when = choice.when === 'today' ? ', due today'
      : choice.when === 'tomorrow' ? ', due tomorrow'
        : choice.when === 'date' ? `, due ${choice.date}` : '';
    return say(201, `Added ${task.title} to ${where}${when}.`);
  } catch (err) {
    if (err instanceof InvalidDueDateError) return say(400, 'I could not read that due date.');
    if (err instanceof InvalidPriorityError) return say(400, 'That priority is not one of P0 to P3.');
    throw err;
  }
}
