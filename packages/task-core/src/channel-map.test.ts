import { it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { syncChannelMap, listChannelMap } from './channel-map.js';
import { getSpaceForChannel } from './context.js';
import { UnknownSpaceError } from './errors.js';

let db: Db;
beforeEach(async () => { db = await createTestDb(); });
afterEach(async () => { await db.close(); });

const CONFIG = {
  C_AGENCY: { name: '#agency-ops', space: 'Agency / Internal' },
  C_SECURE: { name: '#client-secure-logic', space: 'Client - Secure Logic' },
  C_JWB: { name: '#client-joy-within-birth', space: 'joy-within-birth' },
  C_CFC: { name: '#client-cfc-skincare', space: 'CFC Skincare' },
};

it('applies a mapping from configuration and resolves all three name forms', async () => {
  const r = await syncChannelMap(db, CONFIG);
  expect(r.upserted).toBe(4);
  expect((await getSpaceForChannel(db, 'C_AGENCY')).space.name).toBe('Agency / Internal');
  expect((await getSpaceForChannel(db, 'C_JWB')).space.name).toBe('Client - Joy Within Birth');
  expect((await getSpaceForChannel(db, 'C_CFC')).space.name).toBe('Client - CFC Skincare');
});

it('is idempotent — re-syncing changes nothing', async () => {
  await syncChannelMap(db, CONFIG);
  await syncChannelMap(db, CONFIG);
  expect(await listChannelMap(db)).toHaveLength(4);
});

it('updates a channel that has been remapped to a different space', async () => {
  await syncChannelMap(db, CONFIG);
  await syncChannelMap(db, { C_AGENCY: { name: '#agency-ops', space: 'Marketing' } });
  expect((await getSpaceForChannel(db, 'C_AGENCY')).space.name).toBe('Marketing');
  expect(await listChannelMap(db)).toHaveLength(4); // no prune, others survive
});

it('prunes channels absent from config only when asked', async () => {
  await syncChannelMap(db, CONFIG);
  const r = await syncChannelMap(db, { C_AGENCY: { space: 'Agency / Internal' } }, { prune: true });
  expect(r.pruned).toBe(3);
  expect(await listChannelMap(db)).toHaveLength(1);
  expect((await getSpaceForChannel(db, 'C_SECURE')).mapped).toBe(false);
});

it('aborts the entire sync on an unresolvable space, importing nothing', async () => {
  await expect(syncChannelMap(db, {
    C_GOOD: { space: 'Marketing' },
    C_BAD: { space: 'Client - Does Not Exist' },
  })).rejects.toThrow(UnknownSpaceError);

  // Validation happens before any write, so the good row must not exist either.
  expect(await listChannelMap(db)).toHaveLength(0);
});

it('rejects a partial space name rather than guessing', async () => {
  await expect(syncChannelMap(db, { C_X: { space: 'secure' } })).rejects.toThrow(UnknownSpaceError);
});

it('accepts an empty config as a no-op', async () => {
  const r = await syncChannelMap(db, {});
  expect(r.upserted).toBe(0);
  expect(await listChannelMap(db)).toHaveLength(0);
});

it('lists the mapping with channel names for operator review', async () => {
  await syncChannelMap(db, CONFIG);
  const list = await listChannelMap(db);
  expect(list.find((c) => c.channelId === 'C_SECURE')).toEqual({
    channelId: 'C_SECURE',
    channelName: '#client-secure-logic',
    spaceName: 'Client - Secure Logic',
  });
});
