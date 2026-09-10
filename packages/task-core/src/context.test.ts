import { it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { getSpaceForChannel, findSpaceExact, resolveDestinationSpace } from './context.js';
import { UnknownSpaceError } from './errors.js';

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
  const map: Array<[string, string, string]> = [
    ['C_SECURE', '#client-secure-logic', 'Client - Secure Logic'],
    ['C_JWB', '#client-joy-within-birth', 'Client - Joy Within Birth'],
    ['C_CFC', '#client-cfc-skincare', 'Client - CFC Skincare'],
    ['C_AGENCY', '#agency-ops', 'Agency / Internal'],
  ];
  for (const [id, name, space] of map) {
    await db.query(
      `INSERT INTO channel_space_map (slack_channel_id, slack_channel_name, space_id)
       SELECT $1, $2, id FROM spaces WHERE name = $3`,
      [id, name, space]
    );
  }
});
afterAll(async () => { await db.close(); });

it('resolves every mapped channel from the requirement examples', async () => {
  expect((await getSpaceForChannel(db, 'C_SECURE')).space.name).toBe('Client - Secure Logic');
  expect((await getSpaceForChannel(db, 'C_JWB')).space.name).toBe('Client - Joy Within Birth');
  expect((await getSpaceForChannel(db, 'C_CFC')).space.name).toBe('Client - CFC Skincare');
  expect((await getSpaceForChannel(db, 'C_AGENCY')).space.name).toBe('Agency / Internal');
});

it('reports whether a channel was actually mapped', async () => {
  const mapped = await getSpaceForChannel(db, 'C_SECURE');
  expect(mapped.mapped).toBe(true);
  expect(mapped.channelName).toBe('#client-secure-logic');

  const unmapped = await getSpaceForChannel(db, 'C_NOPE');
  expect(unmapped.mapped).toBe(false);
  expect(unmapped.space.name).toBe('Inbox');
  expect(unmapped.channelName).toBeNull();
});

it('falls back to Inbox for a null or empty channel id', async () => {
  for (const id of [null, undefined, '']) {
    const r = await getSpaceForChannel(db, id);
    expect(r.space.is_inbox).toBe(true);
    expect(r.mapped).toBe(false);
  }
});

it('never infers a client from channel-name text when unmapped', async () => {
  // A channel whose NAME screams "secure logic" but which has no mapping row.
  const r = await getSpaceForChannel(db, 'C_client_secure_logic_unmapped');
  expect(r.space.name).toBe('Inbox');
  expect(r.mapped).toBe(false);
});

it('matches a space exactly by canonical name, slug, or client-prefix-free name', async () => {
  expect((await findSpaceExact(db, 'Client - Secure Logic'))?.slug).toBe('secure-logic');
  expect((await findSpaceExact(db, 'secure-logic'))?.slug).toBe('secure-logic');
  expect((await findSpaceExact(db, 'Secure Logic'))?.slug).toBe('secure-logic');
  expect((await findSpaceExact(db, 'AGENCY / INTERNAL'))?.slug).toBe('agency-internal');
  expect((await findSpaceExact(db, 'Agency / Internal'))?.slug).toBe('agency-internal');
});

it('refuses partial and fuzzy space names, unlike the read-path helper', async () => {
  for (const q of ['secure', 'logic', 'joy', 'Client - Secure', 'agency internal', '']) {
    expect(await findSpaceExact(db, q)).toBeNull();
  }
});

it('defaults a destination to the channel mapping', async () => {
  const d = await resolveDestinationSpace(db, { channelId: 'C_SECURE' });
  expect(d.space.name).toBe('Client - Secure Logic');
  expect(d.source).toBe('channel');
});

it('lets an explicit destination win over the channel mapping', async () => {
  const d = await resolveDestinationSpace(db, {
    channelId: 'C_SECURE', space: 'Agency / Internal',
  });
  expect(d.space.name).toBe('Agency / Internal');
  expect(d.source).toBe('explicit');
});

it('accepts an explicit destination in any of the three exact forms', async () => {
  for (const space of ['Agency / Internal', 'agency-internal', 'Marketing']) {
    const d = await resolveDestinationSpace(db, { channelId: 'C_SECURE', space });
    expect(d.source).toBe('explicit');
  }
});

it('falls back to Inbox from an unmapped channel with no explicit destination', async () => {
  const d = await resolveDestinationSpace(db, { channelId: 'C_NOPE' });
  expect(d.space.is_inbox).toBe(true);
  expect(d.source).toBe('inbox');
});

it('raises on an unresolvable explicit destination instead of silently falling back', async () => {
  await expect(
    resolveDestinationSpace(db, { channelId: 'C_SECURE', space: 'Nonexistent Client' })
  ).rejects.toThrow(UnknownSpaceError);

  // Critically: it must NOT quietly land in the channel's space.
  try {
    await resolveDestinationSpace(db, { channelId: 'C_SECURE', space: 'Sekure Logik' });
    expect.unreachable('should have thrown');
  } catch (err) {
    expect(err).toBeInstanceOf(UnknownSpaceError);
    expect((err as UnknownSpaceError).available).toContain('Client - Secure Logic');
  }
});

it('treats a blank explicit destination as absent, not as an error', async () => {
  const d = await resolveDestinationSpace(db, { channelId: 'C_AGENCY', space: '   ' });
  expect(d.space.name).toBe('Agency / Internal');
  expect(d.source).toBe('channel');
});

// --- Approved schema decisions, 2026-09-09 ---

it('resolves Music as its own top-level Space', async () => {
  expect((await findSpaceExact(db, 'Music'))?.slug).toBe('music');
  expect((await findSpaceExact(db, 'music'))?.slug).toBe('music');
  const d = await resolveDestinationSpace(db, { channelId: 'C_SECURE', space: 'Music' });
  expect(d.space.name).toBe('Music');
  expect(d.source).toBe('explicit');
});

it('resolves the "Personal tasks" alias to the Personal Space', async () => {
  expect((await findSpaceExact(db, 'Personal tasks'))?.name).toBe('Personal');
  expect((await findSpaceExact(db, 'personal tasks'))?.name).toBe('Personal');
  expect((await findSpaceExact(db, 'PERSONAL TASKS'))?.name).toBe('Personal');
  const d = await resolveDestinationSpace(db, { space: 'Personal tasks' });
  expect(d.space.name).toBe('Personal');
});

it('still resolves the canonical Personal name', async () => {
  expect((await findSpaceExact(db, 'Personal'))?.name).toBe('Personal');
  expect((await findSpaceExact(db, 'personal'))?.name).toBe('Personal');
});

it('does not treat an alias as a licence for partial matching', async () => {
  for (const q of ['personal task', 'tasks', 'personal stuff']) {
    expect(await findSpaceExact(db, q)).toBeNull();
  }
});
