import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { WEEKLY_CRON } from './schedule.js';

/**
 * Guards on the deployed schedule itself.
 *
 * Vercel's Hobby plan runs a cron entry at most once per day. Since
 * 2026-10-06 the Tasks app needs far less than that: one Monday run that
 * delivers every weekly briefing, and no other schedule. These assertions
 * exist so a future "just make it hourly" -- or a daily entry left behind
 * beside the weekly one -- cannot pass review by accident.
 */
const vercelJson = async () =>
  JSON.parse(await readFile('apps/web/vercel.json', 'utf8')) as {
    crons?: { path: string; schedule: string }[];
  };

/** Cron field order: minute hour day-of-month month day-of-week. */
function fieldsOf(schedule: string): string[] {
  const parts = schedule.trim().split(/\s+/);
  expect(parts, `"${schedule}" is not a 5-field cron expression`).toHaveLength(5);
  return parts;
}

describe('the deployed cron schedule', () => {
  it('has exactly one entry, pointing at the weekly dispatcher', async () => {
    const crons = (await vercelJson()).crons ?? [];
    expect(crons).toHaveLength(1);
    expect(crons[0]!.path).toBe('/api/cron/scheduled');
  });

  it('no longer contains the hourly dispatcher', async () => {
    const crons = (await vercelJson()).crons ?? [];
    expect(crons.map((c) => c.schedule)).not.toContain('0 * * * *');
  });

  it('runs every entry at most once per day', async () => {
    for (const { schedule } of (await vercelJson()).crons ?? []) {
      const [minute, hour] = fieldsOf(schedule);
      // A wildcard, a list, a range or a step in either field means more than
      // one firing a day — which Hobby does not allow and nothing here needs.
      for (const [name, field] of [['minute', minute], ['hour', hour]] as const) {
        expect(field, `${name} in "${schedule}" fires more than once a day`)
          .toMatch(/^\d+$/);
      }
    }
  });

  it('runs once a week, on Mondays only', async () => {
    for (const { schedule } of (await vercelJson()).crons ?? []) {
      const [, , dayOfMonth, month, dayOfWeek] = fieldsOf(schedule);
      expect(dayOfMonth).toBe('*');
      expect(month).toBe('*');
      // 1 is Monday in cron. A list, range, step or wildcard here would mean
      // more than one briefing a week -- the old daily post, back again.
      expect(dayOfWeek).toBe('1');
    }
  });

  it('no longer contains the daily digest', async () => {
    const crons = (await vercelJson()).crons ?? [];
    expect(crons.map((c) => c.schedule)).not.toContain('0 13 * * *');
  });

  it('fires Mondays at 13:00 UTC, the time the daily post used to go out', async () => {
    const crons = (await vercelJson()).crons ?? [];
    expect(crons[0]!.schedule).toBe(WEEKLY_CRON);
    expect(WEEKLY_CRON).toBe('0 13 * * 1');
  });

  it('lands Monday 08:00 Chicago under CDT and 07:00 under CST', async () => {
    // The documented consequence of one fixed UTC hour. Asserted rather than
    // described, so the numbers in SCHEDULED.md cannot quietly become wrong.
    const { DateTime } = await import('luxon');
    const local = (iso: string) =>
      DateTime.fromISO(iso, { zone: 'utc' })
        .setZone('America/Chicago').toFormat('cccc HH:mm');
    expect(local('2026-10-05T13:00:00Z')).toBe('Monday 08:00');  // CDT
    expect(local('2026-11-09T13:00:00Z')).toBe('Monday 07:00');  // CST
    // Even at the latest Hobby may fire it (13:59 UTC), it is still Monday
    // morning in Chicago, so the week key never slips to Sunday's week.
    expect(local('2026-11-09T13:59:00Z')).toBe('Monday 07:59');
  });
});
