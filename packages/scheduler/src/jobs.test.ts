import { it, expect, beforeEach, afterEach, describe } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import {
  completeTask, createSpace, createTask, mapChannelToSpace, moveTask,
} from '@tr/task-core';
import { loadCard } from '@tr/slack-sync';
import type { SchedulerConfig } from './config.js';
import {
  DEFAULT_AGENCY_SPACES, DEFAULT_PERSONAL_SPACES,
} from './config.js';
import {
  DAILY_ANCHORS, getOpenTasks, loadBriefingPlan, tasksForBriefing,
  type SlackPoster,
} from './jobs.js';
import { findBriefing } from './routing.js';
import { runBriefingNow, runWeeklyDispatch, UnknownBriefingError } from './run.js';
import { recentRuns } from './ledger.js';

let db: Db;
const actor = { id: 'U_JOSH', source: 'test' };
const spaceIds: Record<string, string> = {};

interface Post extends Record<string, unknown> { channel: string; text: string }

/** Records every post instead of sending it, and hands back unique timestamps. */
function fakeSlack(fail?: (channel: string) => string | undefined) {
  const posts: Post[] = [];
  let n = 0;
  const client: SlackPoster = {
    chat: {
      postMessage: async (args) => {
        const error = fail?.(String(args.channel));
        if (error) throw new Error(error);
        posts.push(args as Post);
        n += 1;
        return { ts: `1700000000.${String(n).padStart(6, '0')}` };
      },
    },
  };
  return { client, posts };
}

const config: SchedulerConfig = {
  timeZone: 'America/Chicago',
  agencyChannelId: 'C_AGENCY',
  personalChannelId: 'C_PERSONAL',
  agencySpaceKeys: DEFAULT_AGENCY_SPACES,
  personalSpaceKeys: DEFAULT_PERSONAL_SPACES,
  topPerSpace: 10,
  assigneeLabels: {},
};

/** Monday 2026-10-05, 13:00 UTC: the cron's own moment. 08:00 CDT. */
const MONDAY = new Date('2026-10-05T13:00:00Z');

/**
 * The production shape: #agency-ops mapped to Agency / Internal for capture,
 * a Finances Space created by `/space` in #finances, and two client channels.
 * Yoga Farm and the other seeded clients have no channel.
 */
beforeEach(async () => {
  db = await createTestDb();
  await createSpace(db, 'Finances');
  const { rows } = await db.query<{ id: string; name: string }>(`SELECT id, name FROM spaces`);
  for (const r of rows) spaceIds[r.name] = r.id;

  for (const [channelId, spaceName] of [
    ['C_AGENCY', 'Agency / Internal'],
    ['C_MARKETING', 'Marketing'],
    ['C_FINANCE', 'Finances'],
    ['C_JWB', 'Client - Joy Within Birth'],
    ['C_SECURE', 'Client - Secure Logic'],
  ] as const) {
    await mapChannelToSpace(db, { channelId, spaceName });
  }
});
afterEach(async () => { await db.close(); });

const add = (space: string, title: string, priority: 'P0' | 'P1' | 'P2' | 'P3' | null = null) =>
  createTask(db, { title, spaceId: spaceIds[space]!, assigneeId: 'U_JOSH', priority });

const postsTo = (posts: Post[], channel: string) =>
  posts.filter((p) => p.channel === channel);
const textIn = (posts: Post[], channel: string) =>
  postsTo(posts, channel).map((p) => p.text).join('\n');

/** One task in every Space, titled after it. */
async function seedEverySpace(): Promise<void> {
  for (const space of Object.keys(spaceIds)) await add(space, `${space} task`);
}

describe('#agency-ops', () => {
  it('carries agency work plus any client that has no channel of its own', async () => {
    await seedEverySpace();
    const { client, posts } = fakeSlack();
    await runWeeklyDispatch({ db, client, config }, { at: MONDAY });

    const agency = textIn(posts, 'C_AGENCY');
    for (const title of ['Inbox task', 'Agency / Internal task', 'Marketing task', 'Sales task']) {
      expect(agency).toContain(title);
    }
    // Yoga Farm has no channel, so it falls back here.
    expect(agency).toContain('Client - Yoga Farm task');
    // Mapped clients and Finances keep their own channels; Personal stays out.
    for (const title of [
      'Finances task', 'Music task', 'Personal task', 'Client - Joy Within Birth task',
    ]) {
      expect(agency).not.toContain(title);
    }
  });

  it('is headed for the week, not the day', async () => {
    await add('Sales', 'Call Neil');
    const { client, posts } = fakeSlack();
    await runWeeklyDispatch({ db, client, config }, { at: MONDAY });
    expect(postsTo(posts, 'C_AGENCY')[0]!.text)
      .toMatch(/^Agency Tasks — Week of Oct 5\n/);
    expect(posts.map((p) => p.text).join('\n')).not.toContain('Today');
  });
});

describe('client channels', () => {
  it('get only their own client, in the channel mapped to it', async () => {
    await add('Client - Joy Within Birth', 'JWB landing page');
    await add('Client - Secure Logic', 'Secure Logic audit');
    const { client, posts } = fakeSlack();
    await runWeeklyDispatch({ db, client, config }, { at: MONDAY });

    expect(textIn(posts, 'C_JWB')).toContain('JWB landing page');
    expect(textIn(posts, 'C_JWB')).not.toContain('Secure Logic audit');
    expect(textIn(posts, 'C_SECURE')).toContain('Secure Logic audit');
    expect(textIn(posts, 'C_SECURE')).not.toContain('JWB landing page');
  });

  it('pick up a channel mapped since the last run, with no config change', async () => {
    await add('Client - Yoga Farm', 'Yoga Farm retreat page');
    // `/space` or `/map` in #client-yoga-farm, between two Mondays.
    await mapChannelToSpace(db, { channelId: 'C_YOGA', spaceName: 'Client - Yoga Farm' });
    const { client, posts } = fakeSlack();
    await runWeeklyDispatch({ db, client, config }, { at: MONDAY });
    expect(textIn(posts, 'C_YOGA')).toContain('Yoga Farm retreat page');
  });

  it('fall back to #agency-ops for an unmapped client, never unbriefed', async () => {
    await add('Client - Yoga Farm', 'Yoga Farm retreat page');
    const { client, posts } = fakeSlack();
    const report = await runWeeklyDispatch({ db, client, config }, { at: MONDAY });

    expect(textIn(posts, 'C_AGENCY')).toContain('Yoga Farm retreat page');
    expect(report.results.find((r) => r.status === 'unrouted')).toBeUndefined();
  });

  it('stay quiet when the client has nothing open', async () => {
    await add('Client - Joy Within Birth', 'JWB landing page');
    const { client, posts } = fakeSlack();
    const report = await runWeeklyDispatch({ db, client, config }, { at: MONDAY });
    expect(postsTo(posts, 'C_SECURE')).toHaveLength(0);
    expect(report.results.find((r) => r.key === 'secure-logic'))
      .toMatchObject({ status: 'skipped', reason: 'nothing open' });
  });
});

describe('#personal-ops', () => {
  it('carries Personal and Music, and nothing from work or money', async () => {
    await seedEverySpace();
    const { client, posts } = fakeSlack();
    await runWeeklyDispatch({ db, client, config }, { at: MONDAY });

    const personal = textIn(posts, 'C_PERSONAL');
    expect(personal).toContain('Personal task');
    expect(personal).toContain('Music task');
    for (const title of ['Finances task', 'Marketing task', 'Inbox task', 'Client - Joy Within Birth task']) {
      expect(personal).not.toContain(title);
    }
  });

  it('carries a Spiritual Space once one is created', async () => {
    await createSpace(db, 'Spiritual');
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM spaces WHERE name = 'Spiritual'`);
    await createTask(db, { title: 'Read Psalms 1-10', spaceId: rows[0]!.id });
    const { client, posts } = fakeSlack();
    await runWeeklyDispatch({ db, client, config }, { at: MONDAY });
    expect(textIn(posts, 'C_PERSONAL')).toContain('Read Psalms 1-10');
  });
});

describe('the Finance channel', () => {
  it('is the only place finance work goes', async () => {
    await add('Finances', 'Reconcile September');
    const { client, posts } = fakeSlack();
    await runWeeklyDispatch({ db, client, config }, { at: MONDAY });

    const carrying = [...new Set(
      posts.filter((p) => p.text.includes('Reconcile September')).map((p) => p.channel)
    )];
    expect(carrying).toEqual(['C_FINANCE']);
  });
});

describe('no task in two briefings', () => {
  it('posts every routed task exactly once, across every channel', async () => {
    await seedEverySpace();
    const { client, posts } = fakeSlack();
    const report = await runWeeklyDispatch({ db, client, config }, { at: MONDAY });

    // Every checkbox posted, by task id, from the cards the run saved.
    const posted: string[] = [];
    for (const r of report.results) {
      for (const ts of r.messageTimestamps ?? []) {
        const card = await loadCard(db, r.channel!, ts);
        if (card) posted.push(...card.task_ids);
      }
    }
    expect(new Set(posted).size).toBe(posted.length);

    // ...and every open task is either posted or reported, never lost.
    const unrouted = report.results
      .filter((r) => r.status === 'unrouted')
      .reduce((n, r) => n + (r.taskCount ?? 0), 0);
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM tasks WHERE status = 'open'`
    );
    expect(posted.length + unrouted).toBe(rows[0]!.n);
    expect(posts.length).toBeGreaterThan(0);
  });

  it('splits one snapshot, so the briefings partition the open tasks', async () => {
    await seedEverySpace();
    const plan = await loadBriefingPlan(db, config);
    const all = await getOpenTasks(db);
    const ids = plan.briefings.flatMap(
      (b) => tasksForBriefing(b, all).entries.map((e) => e.task.id)
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('what a briefing shows', () => {
  it('excludes completed and waiting tasks, matching `tasks all`', async () => {
    const done = await add('Marketing', 'Already done');
    const blocked = await add('Sales', 'Waiting on Neil');
    await add('Marketing', 'Still open');
    await completeTask(db, done.id, actor);
    await moveTask(db, blocked.id, { status: 'waiting', waitingOn: 'Neil' }, actor);

    const { client, posts } = fakeSlack();
    await runWeeklyDispatch({ db, client, config }, { at: MONDAY });
    const agency = textIn(posts, 'C_AGENCY');
    expect(agency).toContain('Still open');
    expect(agency).not.toContain('Already done');
    expect(agency).not.toContain('Waiting on Neil');
  });

  it('orders each briefing highest priority first', async () => {
    for (const [title, p] of [['None', null], ['Low', 'P3'], ['Critical', 'P0'], ['High', 'P1']] as const) {
      await add('Client - Joy Within Birth', title, p);
    }
    const { client, posts } = fakeSlack();
    await runWeeklyDispatch({ db, client, config }, { at: MONDAY });
    expect(postsTo(posts, 'C_JWB')[0]!.text).toBe(
      'Tasks — Week of Oct 5\n[ ] [P0] Critical\n[ ] [P1] High\n[ ] [P3] Low\n[ ] None'
    );
  });

  it('shows the top tasks per Space and counts the rest', async () => {
    for (let i = 1; i <= 14; i += 1) {
      await add('Marketing', `Marketing ${String(i).padStart(2, '0')}`, i <= 2 ? 'P0' : 'P2');
    }
    await add('Sales', 'Only sales task');
    const { client, posts } = fakeSlack();
    const report = await runWeeklyDispatch({ db, client, config }, { at: MONDAY });

    const agency = textIn(posts, 'C_AGENCY');
    // The P0s make the cut; the overflow is counted, with where to find it.
    expect(agency).toContain('[P0] Marketing 01');
    expect(agency).toContain('[P0] Marketing 02');
    expect(agency).toContain('Only sales task');
    expect(agency).toContain('+4 more in Marketing (`/tasks marketing`)');
    expect(agency.match(/\[ \]/g)).toHaveLength(11);
    expect(report.results.find((r) => r.key === 'agency'))
      .toMatchObject({ taskCount: 15, shownCount: 11 });
  });

  it('saves each message as a card, so the native checkboxes work', async () => {
    const created = await add('Finances', 'Tick me');
    const { client } = fakeSlack();
    const report = await runWeeklyDispatch({ db, client, config }, { at: MONDAY });

    const finance = report.results.find((r) => r.key === 'finances')!;
    const card = await loadCard(db, 'C_FINANCE', finance.messageTimestamps![0]!);
    expect(card!.task_ids).toEqual([created.id]);
    expect(card!.view_scope).toBe('scheduled:weekly-space');
  });

  it('shows no internal id anywhere a person can read it', async () => {
    await seedEverySpace();
    const { client, posts } = fakeSlack();
    await runWeeklyDispatch({ db, client, config }, { at: MONDAY });

    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM tasks UNION ALL SELECT id FROM spaces`
    );
    // Everything rendered, minus the machine-only fields Slack never shows.
    const visible = JSON.stringify(posts, (key, value) =>
      ['value', 'block_id', 'action_id', 'channel'].includes(key) ? undefined : value
    );
    for (const { id } of rows) expect(visible).not.toContain(id);
    expect(visible).not.toMatch(/weekly:|scheduled:|ledger/);
  });

  it('still posts #agency-ops when nothing is open, so silence means failure', async () => {
    const { client, posts } = fakeSlack();
    await runWeeklyDispatch({ db, client, config }, { at: MONDAY });
    expect(textIn(posts, 'C_AGENCY')).toContain('Nothing open.');
    expect(textIn(posts, 'C_PERSONAL')).toContain('Nothing open.');
  });

  it('reads the database at run time, not a snapshot taken earlier', async () => {
    const { client, posts } = fakeSlack();
    await add('Marketing', 'First');
    await runWeeklyDispatch({ db, client, config }, { at: MONDAY });
    await add('Marketing', 'Added later');
    await runWeeklyDispatch(
      { db, client, config }, { at: new Date('2026-10-12T13:00:00Z') }
    );
    expect(textIn(posts, 'C_AGENCY')).toContain('Added later');
  });
});

describe('read-only on tasks', () => {
  it('creates, completes, edits, reassigns and reschedules nothing', async () => {
    await seedEverySpace();
    const snapshot = () => db.query(
      `SELECT id, title, space_id, assignee_id, status, priority, due_at,
              details, completed_at
         FROM tasks ORDER BY id`
    ).then((r) => r.rows);
    const before = await snapshot();

    const { client } = fakeSlack();
    await runWeeklyDispatch({ db, client, config }, { at: MONDAY });
    await runBriefingNow({ db, client, config }, 'agency');

    expect(await snapshot()).toEqual(before);
  });
});

describe('the Daily Anchors Hermes owns', () => {
  const seedAnchors = async () => {
    for (const title of DAILY_ANCHORS) {
      await createTask(db, { title, spaceId: spaceIds['Personal']!, preserveCase: true });
    }
  };

  it('stay out of the Personal briefing', async () => {
    await seedAnchors();
    await add('Personal', 'Buy a new vehicle');
    const plan = await loadBriefingPlan(db, config);
    const personal = tasksForBriefing(findBriefing(plan, 'personal')!, await getOpenTasks(db));
    expect(personal.entries.map((e) => e.task.title)).toEqual(['Buy a new vehicle']);
  });

  it('match the whole title, never a substring', async () => {
    await seedAnchors();
    await add('Personal', 'Meditate with Rachael before the Level 10');
    const { client, posts } = fakeSlack();
    await runWeeklyDispatch({ db, client, config }, { at: MONDAY });
    const personal = textIn(posts, 'C_PERSONAL');
    expect(personal).toContain('Meditate with Rachael before the Level 10');
    for (const anchor of DAILY_ANCHORS) {
      expect(personal.split('\n')).not.toContain(`[ ] ${anchor}`);
    }
  });

  it('still exist everywhere else — this is a delivery rule, not a query', async () => {
    await seedAnchors();
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM tasks WHERE status = 'open'`
    );
    expect(rows[0]!.n).toBe(DAILY_ANCHORS.length);
  });
});

describe('one briefing per channel per week', () => {
  it('does not post again on a retry the same Monday', async () => {
    await seedEverySpace();
    const { client, posts } = fakeSlack();
    await runWeeklyDispatch({ db, client, config }, { at: MONDAY });
    const count = posts.length;

    const retry = await runWeeklyDispatch(
      { db, client, config }, { at: new Date('2026-10-05T13:40:00Z') }
    );
    expect(posts).toHaveLength(count);
    expect(retry.results.filter((r) => r.status !== 'unrouted')
      .every((r) => r.status === 'duplicate')).toBe(true);
  });

  it('does not post again later the same week, whatever triggers it', async () => {
    await add('Marketing', 'Agency work');
    const { client, posts } = fakeSlack();
    await runWeeklyDispatch({ db, client, config }, { at: MONDAY });
    const count = posts.length;
    // Wednesday, and Sunday night -- both still the week of Oct 5 in Chicago.
    await runWeeklyDispatch({ db, client, config }, { at: new Date('2026-10-07T15:00:00Z') });
    await runWeeklyDispatch({ db, client, config }, { at: new Date('2026-10-12T04:30:00Z') });
    expect(posts).toHaveLength(count);
  });

  it('posts again the next Monday', async () => {
    await add('Marketing', 'Agency work');
    const { client, posts } = fakeSlack();
    await runWeeklyDispatch({ db, client, config }, { at: MONDAY });
    const first = posts.length;
    const next = await runWeeklyDispatch(
      { db, client, config }, { at: new Date('2026-10-12T13:00:00Z') }
    );
    expect(next.occurrence).toBe('2026-10-12');
    expect(posts).toHaveLength(first * 2);
  });

  it('keys the ledger to the Monday of the Chicago week', async () => {
    const { client } = fakeSlack();
    const report = await runWeeklyDispatch(
      { db, client, config }, { at: new Date('2026-10-09T18:00:00Z') }
    );
    expect(report.occurrence).toBe('2026-10-05');
    const runs = await recentRuns(db);
    expect(runs.every((r) => r.occurrence === '2026-10-05')).toBe(true);
    expect(runs.map((r) => r.job_key)).toContain('weekly:agency');
  });

  it('does not re-deliver a client whose Space was renamed mid-week', async () => {
    await add('Client - Joy Within Birth', 'JWB landing page');
    const { client, posts } = fakeSlack();
    await runWeeklyDispatch({ db, client, config }, { at: MONDAY });
    await db.query(
      `UPDATE spaces SET name = 'Client - JWB', slug = 'jwb' WHERE id = $1`,
      [spaceIds['Client - Joy Within Birth']]
    );
    await runWeeklyDispatch({ db, client, config }, { at: new Date('2026-10-06T13:00:00Z') });
    expect(postsTo(posts, 'C_JWB')).toHaveLength(1);
  });
});

describe('failure isolation', () => {
  it('still attempts every other channel when one throws', async () => {
    await seedEverySpace();
    const { client, posts } = fakeSlack((ch) => (ch === 'C_AGENCY' ? 'channel_not_found' : undefined));
    const report = await runWeeklyDispatch({ db, client, config }, { at: MONDAY });

    expect(report.results.find((r) => r.key === 'agency')).toMatchObject({ status: 'failed' });
    for (const key of ['personal', 'finances', 'joy-within-birth']) {
      expect(report.results.find((r) => r.key === key)).toMatchObject({ status: 'posted' });
    }
    expect(postsTo(posts, 'C_AGENCY')).toHaveLength(0);
  });

  it('retries only the failed briefing on the next run that week', async () => {
    await add('Marketing', 'Agency work');
    await add('Finances', 'Money work');
    const broken = fakeSlack((ch) => (ch === 'C_FINANCE' ? 'not_in_channel' : undefined));
    await runWeeklyDispatch({ db, client: broken.client, config }, { at: MONDAY });

    const { client, posts } = fakeSlack();
    const retry = await runWeeklyDispatch({ db, client, config }, { at: MONDAY });
    expect(posts.map((p) => p.channel)).toEqual(['C_FINANCE']);
    expect(retry.results.find((r) => r.key === 'agency')!.status).toBe('duplicate');
  });

  it('skips, and says so, when a fixed channel is unconfigured', async () => {
    await add('Personal', 'Personal work');
    const { client, posts } = fakeSlack();
    const report = await runWeeklyDispatch(
      { db, client, config: { ...config, personalChannelId: '' } }, { at: MONDAY }
    );
    expect(report.results.find((r) => r.key === 'personal'))
      .toMatchObject({ status: 'skipped', reason: 'no channel configured' });
    expect(postsTo(posts, 'C_AGENCY')).toHaveLength(1);
  });

  it('never lets a token reach the logs', async () => {
    await add('Marketing', 'Agency work');
    const { client } = fakeSlack(() => 'request failed with Bearer xoxb-4242-secret-value');
    const report = await runWeeklyDispatch({ db, client, config }, { at: MONDAY });
    const failed = report.results.filter((r) => r.status === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    for (const r of failed) {
      expect(r.reason).not.toContain('secret-value');
      expect(r.reason).toContain('***');
    }
  });
});

describe('manual runs', () => {
  it('rehearse without touching the ledger', async () => {
    await add('Marketing', 'Agency work');
    const rehearsal = fakeSlack();
    await runWeeklyDispatch(
      { db, client: rehearsal.client, config }, { at: MONDAY, rehearsal: true }
    );
    expect(rehearsal.posts.length).toBeGreaterThan(0);
    expect(await recentRuns(db)).toEqual([]);

    const live = fakeSlack();
    const report = await runWeeklyDispatch({ db, client: live.client, config }, { at: MONDAY });
    expect(report.results.find((r) => r.key === 'agency')!.status).toBe('posted');
  });

  it('post one briefing now without consuming the week', async () => {
    await add('Client - Joy Within Birth', 'JWB landing page');
    const { client, posts } = fakeSlack();
    const result = await runBriefingNow({ db, client, config }, 'joy-within-birth');
    expect(result.posted).toBe(true);
    expect(posts.map((p) => p.channel)).toEqual(['C_JWB']);

    const report = await runWeeklyDispatch({ db, client, config }, { at: MONDAY });
    expect(report.results.find((r) => r.key === 'joy-within-birth')!.status).toBe('posted');
  });

  it('refuse a briefing that does not exist, or an unmapped Space', async () => {
    const { client, posts } = fakeSlack();
    for (const name of ['agency-daily', 'personal-daily', 'yoga-farm', 'eos-level-10']) {
      await expect(runBriefingNow({ db, client, config }, name))
        .rejects.toBeInstanceOf(UnknownBriefingError);
    }
    expect(posts).toHaveLength(0);
  });
});
