import { DateTime } from 'luxon';

/**
 * Recognises a clock time written inside captured text.
 *
 * Named `findTimeInText` rather than `...InTitle` for two reasons: it takes
 * arbitrary text and has no idea it is looking at a title, and `task-core`
 * exports no name matching /title|rename/i -- a guard from the original spec
 * that keeps the module surface clear of anything reading like a title
 * writer. These two functions only read.
 *
 * The critical difference from the `due:` token: `due:2026-09-15` is a
 * DIRECTIVE, so it is stripped from the title. "Call Andre at 3:30" is prose
 * the user actually typed, so the title keeps every byte of it. This module
 * only reports what it found; it never rewrites the title.
 *
 * No LLM and no fuzzy matching. An enumerated set of shapes, matched by
 * regex, and an explicit rule for the ambiguous case.
 *
 * ## What counts as a time
 *
 * A bare "3:30" is NOT enough. It appears in ratios, scores, version strings
 * and ranges, and guessing there would attach due dates to tasks that have
 * nothing to do with time. A match needs one of two signals:
 *
 *   - a preposition immediately before it -- `at 3:30`, `@ 3:30`, `by 3:30`
 *   - an am/pm suffix -- `3:30pm`, `3pm`
 *
 * ## The ambiguous case
 *
 * "3:30" with no am/pm could be either half of the day. The rule is a fixed
 * daytime table, then roll forward if that instant has passed:
 *
 *   1-6   -> afternoon (13:00-18:00)
 *   7-11  -> morning   (07:00-11:00)
 *   12    -> noon
 *
 * So at 14:45, "at 1:00" is 13:00 -- already gone, so 13:00 tomorrow. And at
 * 14:10, "at 3:30" is 15:30 today.
 *
 * The first version of this used "the next future occurrence" instead, which
 * is equally deterministic and reliably wrong: at 14:45 it read "1:00" as
 * 01:00 tomorrow, when nobody scheduling a call means one in the morning.
 * A fixed table is still a constant, not an interpretation -- it makes no
 * attempt to read intent from the rest of the title. It is just a better
 * constant. Write "1am" when you do mean the small hours.
 */

/**
 * Group 1 hour, 2 minute (optional), 3 meridiem (optional).
 *
 * `(?:^|\s)` and the trailing boundary keep this from matching inside a longer
 * token: "v2:30-rc1" and "ratio 2:1x" do not match.
 */
const TIME_RE = new RegExp(
  // preposition form: at/by/@ 3, 3:30, 3:30pm
  '(?:(?:^|\\s)(?:at|by|@)\\s*(\\d{1,2})(?::(\\d{2}))?\\s*([ap]\\.?m\\.?)?(?=$|[\\s.,;!?)]))' +
  // or meridiem form: 3pm, 3:30 p.m.  (no preposition needed, it is explicit)
  '|(?:(?:^|\\s)(\\d{1,2})(?::(\\d{2}))?\\s*([ap]\\.?m\\.?)(?=$|[\\s.,;!?)]))',
  'i'
);

export interface FoundTime {
  hour: number;
  minute: number;
  /** True when am/pm was written, so the hour needs no disambiguation. */
  explicit: boolean;
}

/** Returns the time written in the text, or null. The text is never modified. */
export function findTimeInText(text: string): FoundTime | null {
  const m = TIME_RE.exec(text);
  if (!m) return null;

  // Whichever alternative matched.
  const rawHour = m[1] ?? m[4];
  const rawMinute = m[2] ?? m[5];
  const rawMeridiem = m[3] ?? m[6];
  if (rawHour === undefined) return null;

  let hour = Number(rawHour);
  const minute = rawMinute === undefined ? 0 : Number(rawMinute);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (minute > 59) return null;

  const meridiem = rawMeridiem?.toLowerCase().replace(/\./g, '') as 'am' | 'pm' | undefined;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    // 12am is 00:00 and 12pm is 12:00, which the modulo handles.
    hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0);
    return { hour, minute, explicit: true };
  }

  if (hour > 23) return null;
  // An hour above 12 is already unambiguous on a 24-hour clock.
  if (hour > 12) return { hour, minute, explicit: true };
  // A bare "at 0" is a stray number far more often than midnight.
  if (hour === 0) return null;
  return { hour, minute, explicit: false };
}

export interface ResolveTimeOptions {
  now: Date;
  timeZone: string;
  /** A day already chosen by a `due:` token; the time then lands on that day. */
  onDay?: Date | null;
}

/**
 * Turns a found time into an instant.
 *
 * With `onDay` set, the `due:` token has already chosen the day and this only
 * supplies the clock -- so "Call Andre at 3:30 due:tomorrow" is tomorrow at
 * 15:30 rather than tomorrow at midnight.
 */
export function resolveCaptureTime(
  found: FoundTime, { now, timeZone, onDay }: ResolveTimeOptions
): Date | null {
  const current = DateTime.fromJSDate(now, { zone: timeZone });
  if (!current.isValid) return null;

  // The same reading in both branches, so `at 3:30` and `at 3:30 due:tomorrow`
  // never disagree about which 3:30 they mean. A test caught them disagreeing.
  const hour = found.explicit ? found.hour : daytimeHour(found.hour);

  if (onDay) {
    const day = DateTime.fromJSDate(onDay, { zone: timeZone });
    if (!day.isValid) return null;
    const at = day.set({ hour, minute: found.minute, second: 0, millisecond: 0 });
    // An explicit day is respected even if the resulting instant is past: the
    // user named the day, and silently moving it would be a guess.
    return at.isValid ? at.toJSDate() : null;
  }

  const today = current.set({
    hour, minute: found.minute, second: 0, millisecond: 0,
  });
  if (!today.isValid) return null;

  // Same clock reading tomorrow if today's has gone. The reading itself never
  // changes, so "at 1:00" is never silently turned into 01:00.
  const chosen = today > current ? today : today.plus({ days: 1 });
  return chosen.isValid ? chosen.toJSDate() : null;
}

/**
 * The fixed daytime table for an hour written without am/pm. See the note at
 * the top of this file for why this is a table rather than a search for the
 * next occurrence.
 */
function daytimeHour(hour: number): number {
  if (hour === 12) return 12;
  if (hour >= 1 && hour <= 6) return hour + 12;
  return hour;
}
