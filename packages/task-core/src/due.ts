import { DateTime } from 'luxon';

/**
 * The zone a due date is read and shown in when nothing says otherwise.
 *
 * Every surface used to have its own answer. Slack captures resolved "today"
 * and "9am" in America/Chicago; the web form and MCP handed a bare
 * `2026-10-14T09:00` to `new Date()`, which a UTC server reads as 9am UTC --
 * 4am in Chicago -- and the web labels then counted days in UTC to match. The
 * pieces agreed with each other only by being wrong the same way, and "Due
 * today" flipped to "Due tomorrow" at 7pm Chicago time.
 *
 * Callers pass their configured zone (`DEFAULT_TIMEZONE`); this is the
 * fallback when they have none.
 */
export const DEFAULT_TIME_ZONE = 'America/Chicago';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** A wall-clock time with no `Z` and no offset: `2026-10-14T09:00[:00[.000]]`. */
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/;

/**
 * Reads a due date typed or sent as text.
 *
 *   "2026-10-14"                  -> the start of Oct 14 in `timeZone`, which
 *                                    is what a Slack "due Oct 14" stores
 *   "2026-10-14T09:00"            -> 9am on Oct 14 in `timeZone`
 *   "2026-10-14T14:00:00Z"        -> exactly that instant; an explicit zone or
 *   "2026-10-14T09:00-05:00"         offset is never second-guessed
 *
 * Anything else falls through to `new Date`, so an unreadable value comes back
 * as an Invalid Date and `createTask`/`editTask` refuse it with
 * InvalidDueDateError exactly as they did before.
 */
export function parseDueInput(raw: string, timeZone: string = DEFAULT_TIME_ZONE): Date {
  const value = raw.trim();
  if (DATE_ONLY.test(value)) {
    return DateTime.fromISO(value, { zone: timeZone }).startOf('day').toJSDate();
  }
  if (LOCAL_DATE_TIME.test(value)) {
    return DateTime.fromISO(value, { zone: timeZone }).toJSDate();
  }
  return new Date(value);
}

/**
 * A due date as a `datetime-local` input value (`YYYY-MM-DDTHH:mm`), in
 * `timeZone`. The inverse of `parseDueInput` for that shape, so opening the
 * edit form and saving it unchanged leaves the due date exactly where it was.
 */
export function formatDueInput(due: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  return DateTime.fromJSDate(due, { zone: timeZone }).toFormat("yyyy-LL-dd'T'HH:mm");
}

/**
 * Whole calendar days from `now` to `date`, counted in `timeZone`: 0 for any
 * time today, 1 for any time tomorrow, -1 for yesterday. A time of day never
 * shifts the answer, and neither does the server's own zone.
 */
export function calendarDaysFrom(
  date: Date, now: Date, timeZone: string = DEFAULT_TIME_ZONE
): number {
  const day = (d: Date) => DateTime.fromJSDate(d, { zone: timeZone }).startOf('day');
  // Rounded, because a day that crosses a DST change is 23 or 25 hours long.
  return Math.round(day(date).diff(day(now), 'days').days);
}

/**
 * The due date one press of "Tomorrow" moves a task to: tomorrow, in
 * `timeZone`, at the time of day it was already due.
 *
 * Keeping the time matters because a capture's time is often the point of
 * it -- "call Neil at 2pm" pushed a day is "call Neil at 2pm tomorrow", not
 * midnight. A date-only due (start of its day) stays date-only. A task with
 * no due date gets the start of tomorrow, the same as a Slack "due tomorrow".
 *
 * Always counted from today, never from the old date: an item three days
 * overdue goes to tomorrow, not to two days ago.
 */
export function tomorrowAt(
  due: Date | null, now: Date, timeZone: string = DEFAULT_TIME_ZONE
): Date {
  const tomorrow = DateTime.fromJSDate(now, { zone: timeZone }).plus({ days: 1 }).startOf('day');
  if (!due) return tomorrow.toJSDate();
  const time = DateTime.fromJSDate(due, { zone: timeZone });
  return tomorrow
    .set({ hour: time.hour, minute: time.minute, second: time.second, millisecond: 0 })
    .toJSDate();
}

/** The four ways the web form offers to set a due date. */
export type DueWhen = 'none' | 'today' | 'tomorrow' | 'date';

export interface DueChoice {
  when: DueWhen;
  /** `YYYY-MM-DD`, read only when `when` is 'date'. */
  date?: string;
  /** `HH:mm`, optional with any day. Blank means "no particular time". */
  time?: string;
}

/**
 * Turns the form's choice into a due date, in `timeZone`.
 *
 * Most due dates are a day, not a moment: "Today" is the start of today, the
 * same thing a Slack "due today" stores, and it reads "Due today" until
 * midnight. A time is the exception and only applies when one was given.
 *
 * Returns null for "no date", and an Invalid Date for a 'date' choice with an
 * unreadable or missing date, so the caller's InvalidDueDateError handling
 * reports it instead of silently saving no date.
 */
export function resolveDueChoice(
  choice: DueChoice, now: Date = new Date(), timeZone: string = DEFAULT_TIME_ZONE
): Date | null {
  const today = DateTime.fromJSDate(now, { zone: timeZone }).startOf('day');
  let day: DateTime;
  if (choice.when === 'none') return null;
  if (choice.when === 'today') day = today;
  else if (choice.when === 'tomorrow') day = today.plus({ days: 1 });
  else {
    const raw = choice.date?.trim() ?? '';
    if (!DATE_ONLY.test(raw)) return new Date(Number.NaN);
    day = DateTime.fromISO(raw, { zone: timeZone }).startOf('day');
    if (!day.isValid) return new Date(Number.NaN);
  }
  const time = /^(\d{2}):(\d{2})$/.exec(choice.time?.trim() ?? '');
  if (time) day = day.set({ hour: Number(time[1]), minute: Number(time[2]) });
  return day.toJSDate();
}

/**
 * The inverse, for prefilling the edit form: which choice reproduces this due
 * date. A due date at local midnight is a day with no time, so its time field
 * stays empty rather than showing "00:00".
 */
export function describeDueChoice(
  due: Date | null, now: Date = new Date(), timeZone: string = DEFAULT_TIME_ZONE
): Required<DueChoice> {
  if (!due) return { when: 'none', date: '', time: '' };
  const local = DateTime.fromJSDate(due, { zone: timeZone });
  const days = calendarDaysFrom(due, now, timeZone);
  const time = local.hour === 0 && local.minute === 0 ? '' : local.toFormat('HH:mm');
  return {
    when: days === 0 ? 'today' : days === 1 ? 'tomorrow' : 'date',
    date: local.toFormat('yyyy-LL-dd'),
    time,
  };
}
