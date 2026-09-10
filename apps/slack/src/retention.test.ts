import { it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import {
  pruneProcessedInteractions, retentionDays, startRetentionSweep, DEFAULT_RETENTION_DAYS,
} from './retention.js';
import { claimInteraction } from '@tr/slack-sync';

let db: Db;
beforeEach(async () => { db = await createTestDb(); });
afterEach(async () => { await db.close(); });

const seedAged = (actionTs: string, daysAgo: number) =>
  db.query(
    `INSERT INTO processed_interactions (channel_id, message_ts, action_ts, processed_at)
     VALUES ('C', '1.1', $1, now() - ($2 || ' days')::interval)`,
    [actionTs, String(daysAgo)]
  );
const count = async () => {
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM processed_interactions`
  );
  return rows[0]!.n;
};

it('removes rows past the window and keeps rows inside it', async () => {
  await seedAged('old-1', 30);
  await seedAged('old-2', 8);
  await seedAged('fresh-1', 6);
  await seedAged('fresh-2', 0);

  expect(await pruneProcessedInteractions(db, 7)).toBe(2);
  expect(await count()).toBe(2);
});

it('keeps a row exactly at the boundary', async () => {
  await seedAged('boundary', 6);
  expect(await pruneProcessedInteractions(db, 7)).toBe(0);
  expect(await count()).toBe(1);
});

it('is safe to run repeatedly and on an empty table', async () => {
  expect(await pruneProcessedInteractions(db, 7)).toBe(0);
  await seedAged('old', 30);
  expect(await pruneProcessedInteractions(db, 7)).toBe(1);
  expect(await pruneProcessedInteractions(db, 7)).toBe(0);
});

it('never lets a nonsense window delete everything', async () => {
  await seedAged('fresh', 0);
  for (const days of [0, -1, -9999, 0.4]) {
    await pruneProcessedInteractions(db, days);
  }
  expect(await count()).toBe(1); // floor of 1 day protects today's rows
});

it('does not break dedupe for interactions still inside the window', async () => {
  expect(await claimInteraction(db, 'C', '1.1', '9.1')).toBe(true);
  await pruneProcessedInteractions(db, 7);
  expect(await claimInteraction(db, 'C', '1.1', '9.1')).toBe(false);
});

it('leaves slack_cards alone, since a card stays clickable indefinitely', async () => {
  await db.query(
    `INSERT INTO slack_cards (channel_id, message_ts, task_ids, rendered_state, updated_at)
     VALUES ('C', '1.1', '{}'::uuid[], '{}'::jsonb, now() - interval '400 days')`
  );
  await pruneProcessedInteractions(db, 7);
  const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM slack_cards`);
  expect(rows[0]!.n).toBe(1);
});

it('reads the retention window from the environment with a sane default', () => {
  expect(retentionDays({} as NodeJS.ProcessEnv)).toBe(DEFAULT_RETENTION_DAYS);
  expect(retentionDays({ INTERACTION_RETENTION_DAYS: '30' } as never)).toBe(30);
  for (const bad of ['abc', '', '0', '-5', 'NaN']) {
    expect(retentionDays({ INTERACTION_RETENTION_DAYS: bad } as never))
      .toBe(DEFAULT_RETENTION_DAYS);
  }
});

it('sweeps immediately and returns a stopper that does not hold the process', async () => {
  await seedAged('old', 30);
  const stop = startRetentionSweep(db, 7, 60_000);
  await new Promise((r) => setTimeout(r, 50));
  expect(await count()).toBe(0);
  stop();
});
