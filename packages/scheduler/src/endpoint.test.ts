import { it, expect, beforeEach, afterEach, describe } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask, mapChannelToSpace } from '@tr/task-core';
import { authorizeCronRequest, handleScheduledRequest } from './endpoint.js';
import type { SlackPoster } from './jobs.js';

let db: Db;
const posts: Record<string, unknown>[] = [];
const client: SlackPoster = {
  chat: {
    postMessage: async (args) => {
      posts.push(args);
      return { ts: `170000.${posts.length}` };
    },
  },
};

const env = {
  CRON_SECRET: 'a-very-secret-value',
  SCHEDULED_AGENCY_CHANNEL_ID: 'C_AGENCY',
  SCHEDULED_PERSONAL_CHANNEL_ID: 'C_PERSONAL',
  DEFAULT_TIMEZONE: 'America/Chicago',
} as unknown as NodeJS.ProcessEnv;

const call = (url: string, token?: string) =>
  handleScheduledRequest(
    new Request(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
    { getDb: async () => db, env, client }
  );

beforeEach(async () => {
  db = await createTestDb();
  posts.length = 0;
});
afterEach(async () => { await db.close(); });

describe('authorization', () => {
  it('accepts the configured bearer token', () => {
    expect(authorizeCronRequest('Bearer s3cret', { CRON_SECRET: 's3cret' } as never))
      .toBe(true);
  });

  it('rejects a wrong token, a missing header, and a bare value', () => {
    const e = { CRON_SECRET: 's3cret' } as never;
    expect(authorizeCronRequest('Bearer nope!!', e)).toBe(false);
    expect(authorizeCronRequest(null, e)).toBe(false);
    expect(authorizeCronRequest('Bearer s3cre', e)).toBe(false);
  });

  it('denies everything when no secret is configured', () => {
    // A deployment that forgot CRON_SECRET must post nothing, not accept anyone.
    expect(authorizeCronRequest('Bearer anything', {} as never)).toBe(false);
    expect(authorizeCronRequest(null, {} as never)).toBe(false);
  });

  it('posts nothing on an unauthorized request', async () => {
    const res = await call('https://x.test/api/cron/scheduled');
    expect(res.status).toBe(401);
    expect(posts).toHaveLength(0);
  });
});

describe('the cron endpoint', () => {
  it('runs the whole weekly dispatch when called with no parameters', async () => {
    // What the Monday Vercel cron does: every briefing, in order, and stop.
    const res = await call('https://x.test/api/cron/scheduled', 'a-very-secret-value');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean; occurrence: string; results: { key: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.results.map((r) => r.key)).toEqual(['agency', 'personal']);
    // Keyed to a Monday, whatever day the test happens to run.
    const { DateTime } = await import('luxon');
    expect(DateTime.fromISO(body.occurrence).weekday).toBe(1);
  });

  it('is idempotent for the week: a second call posts nothing', async () => {
    await call('https://x.test/api/cron/scheduled', 'a-very-secret-value');
    const count = posts.length;
    const res = await call('https://x.test/api/cron/scheduled', 'a-very-secret-value');
    const body = await res.json() as { results: { status: string }[] };
    expect(body.results.every((r) => r.status === 'duplicate')).toBe(true);
    expect(posts).toHaveLength(count);
  });

  it('runs one named briefing on demand', async () => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM spaces WHERE name = 'Marketing'`
    );
    await createTask(db, { title: 'Ship it', spaceId: rows[0]!.id });

    const res = await call(
      'https://x.test/api/cron/scheduled?job=agency', 'a-very-secret-value'
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, manual: true, job: 'agency' });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channel).toBe('C_AGENCY');
  });

  it('runs a mapped client channel by its Space slug', async () => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM spaces WHERE name = 'Client - Yoga Farm'`
    );
    await mapChannelToSpace(db, { channelId: 'C_YOGA', spaceName: 'Client - Yoga Farm' });
    await createTask(db, { title: 'Retreat page', spaceId: rows[0]!.id });

    const res = await call(
      'https://x.test/api/cron/scheduled?job=yoga-farm', 'a-very-secret-value'
    );
    expect(res.status).toBe(200);
    expect(posts.map((p) => p.channel)).toEqual(['C_YOGA']);
  });

  it('rejects an unknown job without posting, and lists the real ones', async () => {
    const res = await call(
      'https://x.test/api/cron/scheduled?job=make-coffee', 'a-very-secret-value'
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, jobs: ['agency', 'personal'] });
    expect(posts).toHaveLength(0);
  });

  it('no longer accepts the retired daily or EOS jobs', async () => {
    for (const job of [
      'agency-daily', 'personal-daily', 'eos-level-10', 'eos-quarterly', 'eos-same-page',
    ]) {
      const res = await call(
        `https://x.test/api/cron/scheduled?job=${job}`, 'a-very-secret-value'
      );
      expect(res.status).toBe(400);
    }
    expect(posts).toHaveLength(0);
  });

  it('runs the Personal briefing on demand, through the production handler', async () => {
    const res = await call(
      'https://x.test/api/cron/scheduled?job=personal', 'a-very-secret-value'
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, manual: true, job: 'personal' });
    expect(posts[0]!.channel).toBe('C_PERSONAL');
  });
});
