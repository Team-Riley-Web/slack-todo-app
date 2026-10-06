import { DateTime } from 'luxon';

/**
 * The scheduler's own zone. The weekly briefings are keyed to Team Riley's
 * working week, not the server's, so a run just after midnight UTC still
 * belongs to the Chicago week it happened in.
 */
export const SCHEDULE_ZONE = 'America/Chicago';

/**
 * The Vercel cron entry, as `apps/web/vercel.json` must hold it.
 *
 * Mondays at 13:00 UTC -- 08:00 Chicago under CDT, 07:00 under CST. Exported
 * so the CLI's `status` and the cron test quote the same string rather than
 * two copies drifting apart.
 */
export const WEEKLY_CRON = '0 13 * * 1';

/**
 * The two briefings with a fixed destination. Every other briefing is one
 * Space posted to the channel that Space is mapped to, and is named by the
 * Space's slug.
 *
 * The daily `agency-daily` / `personal-daily` jobs and the EOS reminders
 * before them are gone. Vercel Cron fires once a week and every briefing is
 * due by definition -- there is no clock to consult and no calendar
 * arithmetic beyond "which week is this".
 */
export type FixedBriefing = 'agency' | 'personal';

export const FIXED_BRIEFINGS: readonly FixedBriefing[] = ['agency', 'personal'];

export interface LocalMoment {
  /** ISO date in the schedule zone, e.g. "2026-09-11". */
  date: string;
  /**
   * The Monday that starts this moment's ISO week, e.g. "2026-09-07". The
   * ledger key: one briefing per Space per week, whichever day it runs.
   */
  week: string;
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
    week: dt.startOf('week').toISODate()!,
    year: dt.year,
    month: dt.month,
    day: dt.day,
    hour: dt.hour,
    minute: dt.minute,
    weekday: dt.weekday,
  };
}
