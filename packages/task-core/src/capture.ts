import { DateTime } from 'luxon';
import { findTimeInText, resolveCaptureTime } from './capture-time.js';

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** Strict: a `due:` token is recognised only as the final whitespace-delimited token. */
const DUE_RE = new RegExp(
  `\\s+due:(\\d{4}-\\d{2}-\\d{2}|today|tomorrow|${WEEKDAYS.join('|')})$`,
  'i'
);

export interface CaptureOptions { now: Date; timeZone: string }
export interface Capture {
  title: string;
  dueAt: Date | null;
  /**
   * True when the due date came from a clock time written in the title rather
   * than from a `due:` token, so the caller can say so. The title is
   * unchanged either way.
   */
  dueFromTitleTime?: boolean;
}

/**
 * The title is the raw input with only its outer whitespace trimmed — the single
 * permitted normalization in the entire system. A trailing `due:` token is a
 * directive, not part of the title, and is stripped only when it fully parses.
 */
export function parseCapture(raw: string, opts: CaptureOptions): Capture {
  const title = raw.trim();
  const match = DUE_RE.exec(title);

  if (!match) return withTitleTime(title, null, opts);

  const dueAt = resolveDue(match[1]!.toLowerCase(), opts);
  if (!dueAt) return withTitleTime(title, null, opts);

  const stripped = title.slice(0, match.index).trimEnd();
  // A due token must never consume the entire input.
  if (!stripped) return withTitleTime(title, null, opts);
  return withTitleTime(stripped, dueAt, opts);
}

/**
 * Applies a clock time written in the title, if there is one.
 *
 * Unlike `due:`, this NEVER touches the title. "Call Andre at 3:30" keeps
 * every byte; only `due_at` is affected. When a `due:` token already chose the
 * day, the time lands on that day instead of overriding it.
 */
function withTitleTime(
  title: string, dueAt: Date | null, opts: CaptureOptions
): Capture {
  const found = findTimeInText(title);
  if (!found) return { title, dueAt };

  const resolved = resolveCaptureTime(found, {
    now: opts.now, timeZone: opts.timeZone, onDay: dueAt,
  });
  if (!resolved) return { title, dueAt };

  return { title, dueAt: resolved, dueFromTitleTime: true };
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
