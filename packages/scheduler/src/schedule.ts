import { DateTime } from 'luxon';

/**
 * The scheduler's own zone. The daily posts are keyed to Team Riley's working
 * day, not the server's, so a run just after midnight UTC still belongs to the
 * Chicago date it happened on.
 */
export const SCHEDULE_ZONE = 'America/Chicago';

/**
 * The two jobs the Tasks app delivers. Both are once-daily morning posts.
 *
 * The EOS reminders that used to live here -- Friday Level 10, the monthly
 * Same-Page meeting, the quarterly planning week -- moved to Hermes on
 * 2026-09-11, and with them went every reason this package needed a clock.
 * There is no `dueJobs`, no grace window and no calendar arithmetic any more:
 * Vercel Cron fires once a day and both jobs are due by definition.
 */
export type JobKey = 'agency-daily' | 'personal-daily';

export const JOB_KEYS: readonly JobKey[] = ['agency-daily', 'personal-daily'];

export interface LocalMoment {
  /** ISO date in the schedule zone, e.g. "2026-09-11". The ledger key. */
  date: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** Luxon's convention: 1 = Monday ... 7 = Sunday. */
  weekday: number;
}

export function localMoment(at: Date, zone: string = SCHEDULE_ZONE): LocalMoment {
  const dt = DateTime.fromJSDate(at, { zone });
  return {
    date: dt.toISODate()!,
    year: dt.year,
    month: dt.month,
    day: dt.day,
    hour: dt.hour,
    minute: dt.minute,
    weekday: dt.weekday,
  };
}
