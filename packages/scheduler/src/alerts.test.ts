import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createSpace, createTask, mapChannelToSpace } from '@tr/task-core';
import {
  DEFAULT_AGENCY_SPACES, DEFAULT_PERSONAL_SPACES, type SchedulerConfig,
} from './config.js';
import { buildCrashAlert, buildRunAlert, explain, sendAlert } from './alerts.js';
import { runWeeklyDispatch } from './run.js';
import { handleScheduledRequest } from './endpoint.js';
import type { SlackPoster } from './jobs.js';

const config: SchedulerConfig = {
  timeZone: 'America/Chicago',
  agencyChannelId: 'C_AGENCY',
  personalChannelId: 'C_PERSONAL',
  agencySpaceKeys: DEFAULT_AGENCY_SPACES,
  personalSpaceKeys: DEFAULT_PERSONAL_SPACES,
  topPerSpace: 10,
  assigneeLabels: {},
  alertUserId: 'U_JOSH',
};
const MONDAY = new Date('2026-10-05T13:00:00Z');

function fakeSlack(fail?: (channel: string) => string | undefined) {
  const posts: Array<{ channel: string; text: string }> = [];
  const client: SlackPoster = {
    chat: {
      postMessage: async (args) => {
        const error = fail?.(String(args.channel));
        if (error) throw new Error(error);
        posts.push({ channel: String(args.channel), text: String(args.text) });
        return { ts: `1.${posts.length}` };
      },
    },
  };
  return { client, posts };
}

describe('explain', () => {
  it('turns Slack error codes into a fix a person can act on', () => {
    expect(explain('An API error occurred: not_in_channel')).toContain('/invite @Tasks');
    expect(explain('channel_not_found')).toContain('/map');
    expect(explain('invalid_auth')).toContain('SLACK_BOT_TOKEN');
    expect(explain('something odd')).toContain('something odd');
  });
});

describe('buildRunAlert', () => {
  it('stays quiet when everything posted, skipped or was a duplicate', () => {
    const results = [
      { key: 'agency', occurrence: '2026-10-05', status: 'posted' as const },
      { key: 'finances', occurrence: '2026-10-05', status: 'skipped' as const },
      { key: 'personal', occurrence: '2026-10-05', status: 'duplicate' as const },
    ];
    expect(buildRunAlert(results, '2026-10-05', config)).toBeNull();
  });

  it('names each failure with its channel and the fix', () => {
    const alert = buildRunAlert([
      { key: 'joy-within-birth', occurrence: 'w', channel: 'C_JWB', status: 'failed', reason: 'not_in_channel' },
    ], '2026-10-05', config)!;
    expect(alert.text).toContain('1 problem');
    expect(alert.text).toContain('<#C_JWB>');
    expect(alert.text).toContain('/invite @Tasks');
    expect(alert.agencyBroken).toBe(false);
  });

  it('flags when #agency-ops itself failed', () => {
    const alert = buildRunAlert([
      { key: 'agency', occurrence: 'w', channel: 'C_AGENCY', status: 'failed', reason: 'is_archived' },
    ], '2026-10-05', config)!;
    expect(alert.agencyBroken).toBe(true);
  });
});

describe('sendAlert', () => {
  it('posts to #agency-ops, and DMs the owner when that fails or is the problem', async () => {
    const a = fakeSlack();
    expect(await sendAlert(a.client, config, { text: 'x', agencyBroken: false })).toBe('channel');
    expect(a.posts[0]!.channel).toBe('C_AGENCY');

    const b = fakeSlack();
    expect(await sendAlert(b.client, config, { text: 'x', agencyBroken: true })).toBe('dm');
    expect(b.posts[0]!.channel).toBe('U_JOSH');

    const c = fakeSlack((ch) => (ch === 'C_AGENCY' ? 'not_in_channel' : undefined));
    expect(await sendAlert(c.client, config, { text: 'x', agencyBroken: false })).toBe('dm');
  });

  it('never throws, even when nothing can be delivered', async () => {
    const { client } = fakeSlack(() => 'boom');
    await expect(sendAlert(client, config, { text: 'x', agencyBroken: false })).resolves.toBe('none');
  });
});

describe('the weekly run', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
    const jwb = (await createSpace(db, 'Client - Joy Within Birth')).space!;
    await createTask(db, { title: 'Landing page', spaceId: jwb.id });
    await mapChannelToSpace(db, { channelId: 'C_JWB', spaceName: 'Client - Joy Within Birth' });
  });
  afterEach(async () => { await db.close?.(); });

  it('alerts #agency-ops when a client channel fails, and the rest still posts', async () => {
    const { client, posts } = fakeSlack((ch) => (ch === 'C_JWB' ? 'not_in_channel' : undefined));
    const report = await runWeeklyDispatch({ db, client, config }, { at: MONDAY });
    expect(report.results.find((r) => r.key === 'joy-within-birth')?.status).toBe('failed');
    const alert = posts.find((p) => p.text.includes('Weekly task briefing'));
    expect(alert?.channel).toBe('C_AGENCY');
    expect(alert?.text).toContain('<#C_JWB>');
  });

  it('DMs the owner when #agency-ops is what failed', async () => {
    const { client, posts } = fakeSlack((ch) => (ch === 'C_AGENCY' ? 'channel_not_found' : undefined));
    await runWeeklyDispatch({ db, client, config }, { at: MONDAY });
    expect(posts.find((p) => p.channel === 'U_JOSH')?.text).toContain('problem');
  });

  it('sends nothing extra on a clean run, and nothing at all in a rehearsal', async () => {
    const clean = fakeSlack();
    await runWeeklyDispatch({ db, client: clean.client, config }, { at: MONDAY });
    expect(clean.posts.some((p) => p.text.includes('problem'))).toBe(false);

    const rehearsal = fakeSlack(() => 'not_in_channel');
    await runWeeklyDispatch({ db, client: rehearsal.client, config }, { at: MONDAY, rehearsal: true });
    expect(rehearsal.posts).toEqual([]);
  });
});

describe('a crash before any briefing', () => {
  it('is announced in Slack and still returns a 500', async () => {
    const { client, posts } = fakeSlack();
    const res = await handleScheduledRequest(
      new Request('https://x/api/cron/scheduled', { headers: { authorization: 'Bearer s3cret' } }),
      {
        getDb: async () => { throw new Error('connection refused'); },
        client,
        env: {
          CRON_SECRET: 's3cret', SCHEDULED_AGENCY_CHANNEL_ID: 'C_AGENCY',
          DEFAULT_ASSIGNEE_SLACK_ID: 'U_JOSH',
        } as NodeJS.ProcessEnv,
      }
    );
    expect(res.status).toBe(500);
    expect(posts[0]!.channel).toBe('C_AGENCY');
    expect(posts[0]!.text).toContain('did not run');
    expect(posts[0]!.text).toContain('connection refused');
    expect(buildCrashAlert(new Error('x')).agencyBroken).toBe(false);
  });
});
