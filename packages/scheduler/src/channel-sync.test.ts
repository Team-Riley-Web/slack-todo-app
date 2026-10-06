import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createSpace, createTask, mapChannelToSpace, type Space } from '@tr/task-core';
import {
  DEFAULT_AGENCY_SPACES, DEFAULT_PERSONAL_SPACES, type SchedulerConfig,
} from './config.js';
import { matchSpace, planChannelMappings, syncChannelMappings } from './channel-sync.js';
import { runWeeklyDispatch } from './run.js';
import type { SlackPoster } from './jobs.js';

const space = (name: string, slug: string, isInbox = false): Space =>
  ({ id: `id-${slug}`, name, slug, is_inbox: isInbox });

const SPACES = [
  space('Inbox', 'inbox', true),
  space('Marketing', 'marketing'),
  space('Personal', 'personal'),
  space('Finances', 'finances'),
  space('Client - Joy Within Birth', 'joy-within-birth'),
  space('Client - Yoga Farm', 'yoga-farm'),
];

const config: SchedulerConfig = {
  timeZone: 'America/Chicago',
  agencyChannelId: 'C_AGENCY',
  personalChannelId: 'C_PERSONAL',
  agencySpaceKeys: DEFAULT_AGENCY_SPACES,
  personalSpaceKeys: DEFAULT_PERSONAL_SPACES,
  topPerSpace: 10,
  assigneeLabels: {},
};

describe('matchSpace', () => {
  it('matches the slug, with or without a client- prefix, ignoring case and #', () => {
    expect(matchSpace('yoga-farm', SPACES)?.slug).toBe('yoga-farm');
    expect(matchSpace('client-yoga-farm', SPACES)?.slug).toBe('yoga-farm');
    expect(matchSpace('#Yoga-Farm', SPACES)?.slug).toBe('yoga-farm');
  });

  it('does not guess from substrings or suffixes', () => {
    for (const n of ['yoga', 'yoga-farm-ops', 'yoga-farm-2', 'general', 'random']) {
      expect(matchSpace(n, SPACES)).toBeNull();
    }
  });
});

describe('planChannelMappings', () => {
  it('maps a new channel to the Space its name points at', () => {
    const out = planChannelMappings(
      [{ id: 'C_NEW', name: 'client-yoga-farm' }], SPACES, [], config
    );
    expect(out).toEqual([expect.objectContaining({
      channelId: 'C_NEW', space: expect.objectContaining({ slug: 'yoga-farm' }),
    })]);
  });

  it('never touches a channel that is already mapped', () => {
    const out = planChannelMappings(
      [{ id: 'C_X', name: 'yoga-farm' }], SPACES,
      [{ channelId: 'C_X', spaceId: 'id-joy-within-birth' }], config
    );
    expect(out).toEqual([]);
  });

  it('does not give a Space a second channel', () => {
    const out = planChannelMappings(
      [{ id: 'C_2', name: 'yoga-farm' }], SPACES,
      [{ channelId: 'C_1', spaceId: 'id-yoga-farm' }], config
    );
    expect(out).toEqual([]);
  });

  it('maps only the first of two channels that match the same Space', () => {
    const out = planChannelMappings(
      [{ id: 'C_B', name: 'yoga-farm' }, { id: 'C_A', name: 'client-yoga-farm' }],
      SPACES, [], config
    );
    expect(out.map((m) => m.channelId)).toEqual(['C_A']);
  });

  it('leaves Inbox, the Agency and Personal Spaces and the fixed channels alone', () => {
    const out = planChannelMappings(
      [
        { id: 'C1', name: 'inbox' }, { id: 'C2', name: 'marketing' },
        { id: 'C3', name: 'personal' }, { id: 'C_AGENCY', name: 'yoga-farm' },
      ],
      SPACES, [], config
    );
    expect(out).toEqual([]);
  });
});

describe('syncChannelMappings and the weekly run', () => {
  let db: Db;
  beforeEach(async () => { db = await createTestDb(); });
  afterEach(async () => { await db.close?.(); });

  const lister = (channels: Array<{ id: string; name: string }>) => ({
    conversations: { list: async () => ({ channels }) },
  });

  async function rows() {
    const r = await db.query<{ slack_channel_id: string; name: string }>(
      `SELECT m.slack_channel_id, s.name FROM channel_space_map m
         JOIN spaces s ON s.id = m.space_id ORDER BY 1`
    );
    return r.rows;
  }

  it('writes the mapping, and writes nothing in a dry run', async () => {
    await createSpace(db, 'Client - Yoga Farm');
    const slack = lister([{ id: 'C_YOGA', name: 'yoga-farm' }]);

    const dry = await syncChannelMappings(db, slack, config, { apply: false });
    expect(dry).toHaveLength(1);
    expect(await rows()).toEqual([]);

    await syncChannelMappings(db, slack, config, { apply: true });
    expect(await rows()).toEqual([{ slack_channel_id: 'C_YOGA', name: 'Client - Yoga Farm' }]);
  });

  it('keeps a hand-made mapping when a name would say otherwise', async () => {
    await createSpace(db, 'Client - Yoga Farm');
    await createSpace(db, 'Client - Joy Within Birth');
    await mapChannelToSpace(db, { channelId: 'C_YOGA', spaceName: 'Client - Joy Within Birth' });
    await syncChannelMappings(db, lister([{ id: 'C_YOGA', name: 'yoga-farm' }]), config, { apply: true });
    expect(await rows()).toEqual([{ slack_channel_id: 'C_YOGA', name: 'Client - Joy Within Birth' }]);
  });

  it('a new client channel is briefed in its own channel on the next run', async () => {
    const space = (await createSpace(db, 'Client - Yoga Farm')).space!;
    await createTask(db, { title: 'Retreat page', spaceId: space.id });
    const posts: Array<Record<string, unknown>> = [];
    const client: SlackPoster = {
      chat: { postMessage: async (a) => { posts.push(a); return { ts: `1.${posts.length}` }; } },
      ...lister([{ id: 'C_YOGA', name: 'client-yoga-farm' }]),
    };
    await runWeeklyDispatch({ db, client, config }, { at: new Date('2026-10-05T13:00:00Z') });
    expect(posts.some((p) => p.channel === 'C_YOGA' && String(p.text).includes('Retreat page'))).toBe(true);
  });

  it('still posts when listing channels fails (e.g. missing_scope)', async () => {
    const posts: Array<Record<string, unknown>> = [];
    const client: SlackPoster = {
      chat: { postMessage: async (a) => { posts.push(a); return { ts: `1.${posts.length}` }; } },
      conversations: { list: async () => { throw new Error('missing_scope'); } },
    };
    await runWeeklyDispatch({ db, client, config }, { at: new Date('2026-10-05T13:00:00Z') });
    expect(posts.some((p) => p.channel === 'C_AGENCY')).toBe(true);
  });
});
