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
 * "3:30" with no am/pm could be either half of the day. The rule is the next
 * future occurrence: at 14:10, "3:30" resolves to 15:30 today, because 03:30
 * has already passed. At 16:00 it resolves to 03:30 tomorrow -- which is
 * probably not what a person meant, but it is predictable, and the fix is to
 * type "3:30pm" or add `due:tomorrow`. Guessing an intention would put this
 * code in the business of interpretation, which is the one thing the system
 * refuses to do.
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

  if (onDay) {
    const day = DateTime.fromJSDate(onDay, { zone: timeZone });
    if (!day.isValid) return null;
    const at = day.set({
      hour: found.hour, minute: found.minute, second: 0, millisecond: 0,
    });
    // An explicit day is respected even if the resulting instant is past: the
    // user named the day, and silently moving it would be a guess.
    return at.isValid ? at.toJSDate() : null;
  }

  const candidates: DateTime[] = [];
  const push = (hour: number, dayOffset: number) => {
    const dt = current
      .plus({ days: dayOffset })
      .set({ hour, minute: found.minute, second: 0, millisecond: 0 });
    if (dt.isValid) candidates.push(dt);
  };

  if (found.explicit) {
    push(found.hour, 0);
    push(found.hour, 1);
  } else {
    // Both halves of today, then both halves of tomorrow, in chronological
    // order, so "the next future occurrence" is just the first one left.
    const am = found.hour % 12;
    const pm = am + 12;
    push(am, 0);
    push(pm, 0);
    push(am, 1);
    push(pm, 1);
  }

  const next = candidates
    .filter((c) => c > current)
    .sort((a, b) => a.toMillis() - b.toMillis())[0];
  return next ? next.toJSDate() : null;
}
