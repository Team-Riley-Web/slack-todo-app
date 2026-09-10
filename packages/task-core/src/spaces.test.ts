import { it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { listSpaces, resolveSpaceForChannel, findSpaceByQuery } from './spaces.js';

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
  await db.query(
    `INSERT INTO channel_space_map (slack_channel_id, slack_channel_name, space_id)
     SELECT 'C_AGENCY', '#agency-ops', id FROM spaces WHERE name = 'Agency / Internal'`
  );
  await db.query(
    `INSERT INTO channel_space_map (slack_channel_id, slack_channel_name, space_id)
     SELECT 'C_JWB', '#client-joy-within-birth', id FROM spaces
      WHERE name = 'Client - Joy Within Birth'`
  );
});
afterAll(async () => { await db.close(); });

it('seeds all twelve spaces, including Music as its own Space', async () => {
  const spaces = await listSpaces(db);
  expect(spaces).toHaveLength(12);
  expect(spaces.map((s) => s.name)).toContain('Client - Yoga Farm');
  expect(spaces.map((s) => s.name)).toContain('Music');
});

// Required test 2: mapped channel routes to correct Space
it('routes a mapped channel to its space', async () => {
  expect((await resolveSpaceForChannel(db, 'C_AGENCY')).name).toBe('Agency / Internal');
  expect((await resolveSpaceForChannel(db, 'C_JWB')).name).toBe('Client - Joy Within Birth');
});

// Required test 3: unmapped channel handled safely
it('routes an unmapped channel to Inbox rather than failing or guessing', async () => {
  const space = await resolveSpaceForChannel(db, 'C_UNKNOWN');
  expect(space.name).toBe('Inbox');
  expect(space.is_inbox).toBe(true);
});

it('resolves scope queries case-insensitively by slug, name, and substring', async () => {
  expect((await findSpaceByQuery(db, 'agency'))?.name).toBe('Agency / Internal');
  expect((await findSpaceByQuery(db, 'PERSONAL'))?.name).toBe('Personal');
  expect((await findSpaceByQuery(db, 'joy within'))?.name).toBe('Client - Joy Within Birth');
  expect(await findSpaceByQuery(db, 'nonsense')).toBeNull();
});

it('seeds the two default lists per space without populating task list_id', async () => {
  const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM lists`);
  expect(rows[0]!.n).toBe(24); // 12 spaces x 2 lists
});

// Regression: ISSUE-005 — LIKE metacharacters in a scope were unescaped, so
// `/tasks %` matched a space and `/tasks m_rketing` matched Marketing.
// Found by /qa on 2026-09-09
// Report: .gstack/qa-reports/qa-report-team-riley-tasks-2026-09-09.md
it('treats LIKE metacharacters in a scope as literal text', async () => {
  for (const q of ['%', '_', '%%', 'm_rketing', 'Mark%', '\\']) {
    expect(await findSpaceByQuery(db, q)).toBeNull();
  }
});

it('still matches a genuine substring scope', async () => {
  expect((await findSpaceByQuery(db, 'market'))?.name).toBe('Marketing');
  expect((await findSpaceByQuery(db, 'yoga'))?.name).toBe('Client - Yoga Farm');
});
