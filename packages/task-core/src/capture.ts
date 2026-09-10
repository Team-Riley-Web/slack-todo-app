import { DateTime } from 'luxon';

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** Strict: a `due:` token is recognised only as the final whitespace-delimited token. */
const DUE_RE = new RegExp(
  `\\s+due:(\\d{4}-\\d{2}-\\d{2}|today|tomorrow|${WEEKDAYS.join('|')})$`,
  'i'
);

export interface CaptureOptions { now: Date; timeZone: string }
export interface Capture { title: string; dueAt: Date | null }

/**
 * The title is the raw input with only its outer whitespace trimmed — the single
 * permitted normalization in the entire system. A trailing `due:` token is a
 * directive, not part of the title, and is stripped only when it fully parses.
 */
export function parseCapture(raw: string, opts: CaptureOptions): Capture {
  const title = raw.trim();
  const match = DUE_RE.exec(title);
  if (!match) return { title, dueAt: null };

  const dueAt = resolveDue(match[1]!.toLowerCase(), opts);
  if (!dueAt) return { title, dueAt: null };

  const stripped = title.slice(0, match.index).trimEnd();
  // A due token must never consume the entire input.
  if (!stripped) return { title, dueAt: null };
  return { title: stripped, dueAt };
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
