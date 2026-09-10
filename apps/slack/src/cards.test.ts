import { it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { claimInteraction } from './cards.js';

let db: Db;
beforeEach(async () => { db = await createTestDb(); });
afterEach(async () => { await db.close(); });

it('claims a first interaction and rejects its exact retry', async () => {
  expect(await claimInteraction(db, 'C', '1.1', '9.1')).toBe(true);
  expect(await claimInteraction(db, 'C', '1.1', '9.1')).toBe(false);
});

it('treats distinct action timestamps on one message as distinct interactions', async () => {
  expect(await claimInteraction(db, 'C', '1.1', '9.1')).toBe(true);
  expect(await claimInteraction(db, 'C', '1.1', '9.2')).toBe(true);
});

// Regression: ISSUE-001 — a blank action_ts deduped every later toggle on the
// same message, silently swallowing real clicks after the first.
// Found by /qa on 2026-09-09
// Report: .gstack/qa-reports/qa-report-team-riley-tasks-2026-09-09.md
it('never dedupes on a blank action_ts, which cannot identify an interaction', async () => {
  expect(await claimInteraction(db, 'C', '1.1', '')).toBe(true);
  expect(await claimInteraction(db, 'C', '1.1', '')).toBe(true);
  expect(await claimInteraction(db, 'C', '1.1', '')).toBe(true);
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM processed_interactions`
  );
  expect(rows[0]!.n).toBe(0); // nothing recorded, so nothing to falsely match
});

it('scopes dedupe per message, not per channel', async () => {
  expect(await claimInteraction(db, 'C', '1.1', '9.1')).toBe(true);
  expect(await claimInteraction(db, 'C', '2.2', '9.1')).toBe(true);
});
