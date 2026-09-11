import { DateTime } from 'luxon';
import { findTimeInText, resolveCaptureTime } from './capture-time.js';
import type { Priority } from './priority.js';

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** Strict: a `due:` token is recognised only as the final whitespace-delimited token. */
const DUE_RE = new RegExp(
  `\\s+due:(\\d{4}-\\d{2}-\\d{2}|today|tomorrow|${WEEKDAYS.join('|')})$`,
  'i'
);

/**
 * Strict: a priority is recognised only as the FIRST whitespace-delimited
 * token, and only when something follows it.
 *
 * Leading-only, deliberately, for the same reason `due:` is trailing-only.
 * "P1", "P2" and "P3" are real text -- "Order 20 P2 cable ties", "chase the P1
 * visa application", "replace the P3 bracket" -- and a parser that matched them
 * anywhere in the string would silently delete words out of a title. A title
 * almost never OPENS with a bare "P2 ", so that one position is unambiguous.
 *
 * `\s+` after the token is what rejects "P01 ...": the character following
 * "P0" there is "1", not whitespace, so nothing matches and the title is kept
 * whole.
 */
const PRIORITY_RE = /^(p[0-3])\s+/i;

export interface CaptureOptions { now: Date; timeZone: string }
export interface Capture {
  title: string;
  dueAt: Date | null;
  /** P0-P3 lifted out of the text, or null when none was written. */
  priority: Priority | null;
  /**
   * True when the due date came from a clock time written in the title rather
   * than from a `due:` token, so the caller can say so. The title is
   * unchanged either way.
   */
  dueFromTitleTime?: boolean;
}

/**
 * The title is the raw input with its outer whitespace trimmed, and its opening
 * letter capitalised at the write path (see capitalize.ts). Everything else is
 * kept byte for byte.
 *
 * Two tokens are DIRECTIVES rather than part of what you wrote, and are lifted
 * out into structured fields: a trailing `due:`, and a leading `P0`-`P3`. Each
 * is stripped only when it fully parses and never when stripping it would leave
 * no title at all.
 */
export function parseCapture(raw: string, opts: CaptureOptions): Capture {
  const trimmed = raw.trim();
  const { title: afterPriority, priority } = takePriority(trimmed);
  const title = afterPriority;
  const match = DUE_RE.exec(title);

  if (!match) return withTitleTime(title, null, opts, priority);

  const dueAt = resolveDue(match[1]!.toLowerCase(), opts);
  if (!dueAt) return withTitleTime(title, null, opts, priority);

  const stripped = title.slice(0, match.index).trimEnd();
  // A due token must never consume the entire input.
  if (!stripped) return withTitleTime(title, null, opts, priority);
  return withTitleTime(stripped, dueAt, opts, priority);
}

/**
 * Lifts a leading priority token off the text.
 *
 * Like `due:`, it is a DIRECTIVE rather than part of what you wrote, so it is
 * removed from the title and stored as structured data -- `P0 Fix Stripe
 * checkout` is a P0 task called "Fix Stripe checkout", not a task whose title
 * happens to begin with "P0".
 *
 * Never consumes the whole input: `/task P0` on its own is a task called "P0",
 * not a priority with no task, because the regex requires whitespace and the
 * remainder is checked for content.
 */
function takePriority(text: string): { title: string; priority: Priority | null } {
  const match = PRIORITY_RE.exec(text);
  if (!match) return { title: text, priority: null };

  const rest = text.slice(match[0].length).trim();
  if (!rest) return { title: text, priority: null };

  return { title: rest, priority: match[1]!.toUpperCase() as Priority };
}

/**
 * Applies a clock time written in the title, if there is one.
 *
 * Unlike `due:`, this NEVER touches the title. "Call Andre at 3:30" keeps
 * every byte; only `due_at` is affected. When a `due:` token already chose the
 * day, the time lands on that day instead of overriding it.
 */
function withTitleTime(
  title: string, dueAt: Date | null, opts: CaptureOptions,
  priority: Priority | null = null
): Capture {
  const found = findTimeInText(title);
  if (!found) return { title, dueAt, priority };

  const resolved = resolveCaptureTime(found, {
    now: opts.now, timeZone: opts.timeZone, onDay: dueAt,
  });
  if (!resolved) return { title, dueAt, priority };

  return { title, dueAt: resolved, priority, dueFromTitleTime: true };
}

function resolveDue(token: string, { now, timeZone }: CaptureOptions): Date | null {
  const today = DateTime.fromJSDate(now, { zone: timeZone }).startOf('day');

  if (token === 'today') return today.toJSDate();
  if (token === 'tomorrow') return today.plus({ days: 1 }).toJSDate();

  const weekday = WEEKDAYS.indexOf(token as (typeof WEEKDAYS)[number]);
  if (weekday >= 0) {
    const target = weekday + 1; // luxon: Monday = 1
    const delta = (target - today.weekday + 7) % 7 || 7; // strictly future
    return today.plus({ days: delta }).toJSDate();
  }

  const dt = DateTime.fromISO(token, { zone: timeZone }).startOf('day');
  return dt.isValid ? dt.toJSDate() : null;
}
