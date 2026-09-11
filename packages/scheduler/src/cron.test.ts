import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';

/**
 * Guards on the deployed schedule itself.
 *
 * Vercel's Hobby plan runs a cron entry at most once per day, and the whole
 * point of the 2026-09-11 refactor was that the Tasks app no longer needs
 * anything finer: it delivers two morning posts and owns no other schedule.
 * These assertions exist so a future "just make it hourly" cannot pass review
 * by accident.
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
  it('has exactly one entry, pointing at the daily dispatcher', async () => {
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

  it('fires at 13:00 UTC, the closest clean once-daily fit to 8am Chicago', async () => {
    const crons = (await vercelJson()).crons ?? [];
    expect(crons[0]!.schedule).toBe('0 13 * * *');
  });

  it('lands at 08:00 Chicago under CDT and 07:00 under CST', async () => {
    // The documented consequence of one fixed UTC hour. Asserted rather than
    // described, so the number in SCHEDULED.md cannot quietly become wrong.
    const { DateTime } = await import('luxon');
    const local = (iso: string) =>
      DateTime.fromISO(iso, { zone: 'utc' })
        .setZone('America/Chicago').toFormat('HH:mm');
    expect(local('2026-07-15T13:00:00Z')).toBe('08:00');  // CDT
    expect(local('2026-01-15T13:00:00Z')).toBe('07:00');  // CST
  });
});
