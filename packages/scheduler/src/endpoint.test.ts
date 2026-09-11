import { it, expect, beforeEach, afterEach, describe } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask } from '@tr/task-core';
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
  it('runs the whole daily dispatch when called with no parameters', async () => {
    // What the once-daily Vercel cron does: both posts, in order, and stop.
    const res = await call('https://x.test/api/cron/scheduled', 'a-very-secret-value');
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; results: { key: string }[] };
    expect(body.ok).toBe(true);
    expect(body.results.map((r) => r.key)).toEqual(['agency-daily', 'personal-daily']);
  });

  it('runs one named job on demand', async () => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM spaces WHERE name = 'Marketing'`
    );
    await createTask(db, { title: 'Ship it', spaceId: rows[0]!.id });

    const res = await call(
      'https://x.test/api/cron/scheduled?job=agency-daily', 'a-very-secret-value'
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, manual: true, job: 'agency-daily' });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channel).toBe('C_AGENCY');
  });

  it('rejects an unknown job without posting', async () => {
    const res = await call(
      'https://x.test/api/cron/scheduled?job=make-coffee', 'a-very-secret-value'
    );
    expect(res.status).toBe(400);
    expect(posts).toHaveLength(0);
  });

  it('no longer accepts the retired EOS jobs', async () => {
    // Hermes owns these now. They must not be reachable here at all.
    for (const job of ['eos-level-10', 'eos-quarterly', 'eos-same-page']) {
      const res = await call(
        `https://x.test/api/cron/scheduled?job=${job}`, 'a-very-secret-value'
      );
      expect(res.status).toBe(400);
    }
    expect(posts).toHaveLength(0);
  });

  it('runs the Personal post on demand, through the production handler', async () => {
    const res = await call(
      'https://x.test/api/cron/scheduled?job=personal-daily', 'a-very-secret-value'
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, manual: true, job: 'personal-daily' });
    expect(posts[0]!.channel).toBe('C_PERSONAL');
  });
});
