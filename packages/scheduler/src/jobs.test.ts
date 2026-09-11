import { it, expect, beforeEach, afterEach, describe } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { completeTask, createTask, moveTask } from '@tr/task-core';
import { loadCard } from '@tr/slack-sync';
import type { SchedulerConfig } from './config.js';
import {
  getAllOpenAgencyTasks, getAllOpenPersonalTasks,
  postAgencyDailyTasks, postPersonalDailyTasks,
  DAILY_ANCHORS, type SlackPoster,
} from './jobs.js';
import { runDailyDispatch, runJobNow } from './run.js';
import { recentRuns } from './ledger.js';

let db: Db;
const actor = { id: 'U_JOSH', source: 'test' };
const spaceIds: Record<string, string> = {};

/** Records every post instead of sending it, and hands back real timestamps. */
function fakeSlack() {
  const posts: Record<string, unknown>[] = [];
  let n = 0;
  const client: SlackPoster = {
    chat: {
      postMessage: async (args) => {
        posts.push(args);
        n += 1;
        return { ts: `17000000.0000${n}` };
      },
    },
  };
  return { client, posts };
}

const config: SchedulerConfig = {
  timeZone: 'America/Chicago',
  agencyChannelId: 'C_AGENCY',
  personalChannelId: 'C_PERSONAL',
  personalSpaceKeys: ['personal'],
  assigneeLabels: {},
};

beforeEach(async () => {
  db = await createTestDb();
  const { rows } = await db.query<{ id: string; name: string }>(`SELECT id, name FROM spaces`);
  for (const r of rows) spaceIds[r.name] = r.id;
});
afterEach(async () => { await db.close(); });

const add = (space: string, title: string) =>
  createTask(db, { title, spaceId: spaceIds[space]!, assigneeId: 'U_JOSH' });

describe('the Agency / Personal split', () => {
  it('puts everything that is not Personal in the Agency digest', async () => {
    await add('Agency / Internal', 'Internal one');
    await add('Marketing', 'Marketing one');
    await add('Sales', 'Sales one');
    await add('Client - Yoga Farm', 'Client one');
    await add('Music', 'Music one');
    await add('Inbox', 'Inbox one');
    await add('Personal', 'Personal one');

    const agency = await getAllOpenAgencyTasks(db, config);
    expect(agency.entries.map((e) => e.task.title).sort()).toEqual([
      'Client one', 'Inbox one', 'Internal one', 'Marketing one',
      'Music one', 'Sales one',
    ]);
    expect(agency.entries.map((e) => e.task.title)).not.toContain('Personal one');
  });

  it('puts only Personal in the Personal digest', async () => {
    await add('Agency / Internal', 'Internal one');
    await add('Personal', 'Personal one');
    await add('Personal', 'Personal two');

    const personal = await getAllOpenPersonalTasks(db, config);
    expect(personal.entries.map((e) => e.task.title).sort())
      .toEqual(['Personal one', 'Personal two']);
  });

  it('covers every task between the two, so nothing falls through', async () => {
    for (const space of Object.keys(spaceIds)) await add(space, `${space} task`);

    const agency = await getAllOpenAgencyTasks(db, config);
    const personal = await getAllOpenPersonalTasks(db, config);
    const { rows } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM tasks WHERE status = 'open'`
    );
    expect(agency.entries.length + personal.entries.length).toBe(Number(rows[0]!.n));
  });
});

describe('what a digest includes', () => {
  it('excludes completed tasks', async () => {
    const done = await add('Marketing', 'Already done');
    await add('Marketing', 'Still open');
    await completeTask(db, done.id, actor);

    const agency = await getAllOpenAgencyTasks(db, config);
    expect(agency.entries.map((e) => e.task.title)).toEqual(['Still open']);
  });

  it('excludes waiting tasks, matching `tasks all`', async () => {
    const blocked = await add('Sales', 'Waiting on Neil');
    await add('Sales', 'Actionable');
    await moveTask(db, blocked.id, { status: 'waiting', waitingOn: 'Neil' }, actor);

    const agency = await getAllOpenAgencyTasks(db, config);
    expect(agency.entries.map((e) => e.task.title)).toEqual(['Actionable']);
  });

  it('reads the database at run time, not a snapshot taken earlier', async () => {
    const { client, posts } = fakeSlack();
    await add('Marketing', 'First');
    await postAgencyDailyTasks({ db, client, config });
    expect(posts[0]!.text).toContain('First');

    await add('Marketing', 'Added later');
    await postAgencyDailyTasks({ db, client, config });
    expect(posts[1]!.text).toContain('Added later');
  });
});

describe('priority ordering in the daily digests', () => {
  /**
   * Nothing in the scheduler sorts. It inherits `TASK_ORDER_BY` by going
   * through listOpenTasksBySpace, which is the point of putting the ordering
   * in the query layer rather than in each surface.
   */
  const seedPriorities = async (space: string) => {
    for (const [title, priority] of [
      ['None', null], ['Low', 'P3'], ['Critical', 'P0'], ['High', 'P1'],
    ] as const) {
      await createTask(db, {
        title, spaceId: spaceIds[space]!, priority, assigneeId: 'U_JOSH',
      });
    }
  };

  it('orders the Agency digest highest priority first', async () => {
    const { client, posts } = fakeSlack();
    await seedPriorities('Marketing');
    await postAgencyDailyTasks({ db, client, config });
    // Ordered by priority, and each row carries its tag.
    expect(posts[0]!.text).toBe(
      'Agency Tasks — Today\n[ ] [P0] Critical\n[ ] [P1] High\n[ ] [P3] Low\n[ ] None'
    );
  });

  it('orders the Personal digest the same way', async () => {
    const { client, posts } = fakeSlack();
    await seedPriorities('Personal');
    await postPersonalDailyTasks({ db, client, config });
    expect(posts[0]!.text).toBe(
      'Personal Tasks — Today\n[ ] [P0] Critical\n[ ] [P1] High\n[ ] [P3] Low\n[ ] None'
    );
  });
});

describe('posting a digest', () => {
  it('sends the Agency list to the Agency channel under the right heading', async () => {
    const { client, posts } = fakeSlack();
    await add('Agency / Internal', 'Internal one');

    const result = await postAgencyDailyTasks({ db, client, config });
    expect(result.posted).toBe(true);
    expect(result.taskCount).toBe(1);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channel).toBe('C_AGENCY');
    expect(posts[0]!.text).toContain('Agency Tasks — Today');
  });

  it('sends the Personal list to the Personal channel', async () => {
    const { client, posts } = fakeSlack();
    await add('Personal', 'Personal one');

    await postPersonalDailyTasks({ db, client, config });
    expect(posts[0]!.channel).toBe('C_PERSONAL');
    expect(posts[0]!.text).toContain('Personal Tasks — Today');
  });

  it('saves each posted message as a card, so the checkboxes work', async () => {
    const { client } = fakeSlack();
    const created = await add('Marketing', 'Tick me');

    const result = await postAgencyDailyTasks({ db, client, config });
    const card = await loadCard(db, 'C_AGENCY', result.messageTimestamps[0]!);
    expect(card).not.toBeNull();
    expect(card!.task_ids).toEqual([created.id]);
    expect(card!.view_scope).toBe('scheduled:agency-daily');
  });

  it('still posts when nothing is open, so a silent morning means a failure', async () => {
    const { client, posts } = fakeSlack();
    const result = await postPersonalDailyTasks({ db, client, config });
    expect(result.posted).toBe(true);
    expect(posts[0]!.text).toContain('Nothing open.');
  });

  it('skips rather than throws when its channel is unconfigured', async () => {
    const { client, posts } = fakeSlack();
    await add('Personal', 'Personal one');
    const result = await postPersonalDailyTasks({
      db, client, config: { ...config, personalChannelId: '' },
    });
    expect(result.posted).toBe(false);
    expect(result.reason).toBe('no channel configured');
    expect(posts).toHaveLength(0);
  });

  it('does not let an unset Personal channel stop the Agency digest', async () => {
    const { client, posts } = fakeSlack();
    await add('Marketing', 'Agency work');
    await add('Personal', 'Personal work');

    const report = await runDailyDispatch(
      { db, client, config: { ...config, personalChannelId: '' } },
      { at: new Date('2026-09-11T13:00:00Z') }
    );
    expect(report.results.find((r) => r.key === 'agency-daily')!.status).toBe('posted');
    expect(report.results.find((r) => r.key === 'personal-daily')!.status).toBe('skipped');
    expect(posts).toHaveLength(1);
  });
});

describe('the Daily Anchors Hermes owns', () => {
  const seedAnchors = async () => {
    for (const title of DAILY_ANCHORS) {
      await createTask(db, { title, spaceId: spaceIds['Personal']!, preserveCase: true });
    }
  };

  it('leaves all five out of the Personal digest', async () => {
    await seedAnchors();
    await add('Personal', 'Buy a new vehicle');

    const personal = await getAllOpenPersonalTasks(db, config);
    expect(personal.entries.map((e) => e.task.title)).toEqual(['Buy a new vehicle']);
  });

  it('matches the whole title, never a substring', async () => {
    // "Meditate" is Hermes's. "Meditate with Rachael before the Level 10" is a
    // real one-off task and must survive — a substring rule would eat it.
    await seedAnchors();
    await add('Personal', 'Meditate with Rachael before the Level 10');
    await add('Personal', 'Book the exercise bike service');

    const titles = (await getAllOpenPersonalTasks(db, config))
      .entries.map((e) => e.task.title).sort();
    expect(titles).toEqual([
      'Book the exercise bike service',
      'Meditate with Rachael before the Level 10',
    ]);
  });

  it('ignores case and surrounding whitespace', async () => {
    await createTask(db, {
      title: '  cold exposure  ', spaceId: spaceIds['Personal']!, preserveCase: true,
    });
    expect((await getAllOpenPersonalTasks(db, config)).entries).toEqual([]);
  });

  it('drops a Space left with nothing rather than posting it empty', async () => {
    await seedAnchors();
    const personal = await getAllOpenPersonalTasks(db, config);
    expect(personal.groups).toEqual([]);
  });

  it('does not touch the Agency digest', async () => {
    await seedAnchors();
    await add('Marketing', 'Exercise');  // Same word, different Space.
    const agency = await getAllOpenAgencyTasks(db, config);
    expect(agency.entries.map((e) => e.task.title)).toEqual(['Exercise']);
  });

  it('still shows them everywhere else — this is a delivery rule, not a query', async () => {
    await seedAnchors();
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM tasks WHERE status = 'open'`
    );
    expect(rows[0]!.n).toBe(DAILY_ANCHORS.length);
  });
});

describe('the daily dispatch', () => {
  const at = new Date('2026-09-11T13:00:00Z');

  it('posts Agency then Personal, and stops', async () => {
    const { client, posts } = fakeSlack();
    await add('Marketing', 'Agency work');
    await add('Personal', 'Personal work');

    const report = await runDailyDispatch({ db, client, config }, { at });
    expect(report.results.map((r) => r.key)).toEqual(['agency-daily', 'personal-daily']);
    expect(report.results.every((r) => r.status === 'posted')).toBe(true);
    expect(posts.map((p) => p.channel)).toEqual(['C_AGENCY', 'C_PERSONAL']);
  });

  it('reads the database at run time, never a snapshot', async () => {
    const { client, posts } = fakeSlack();
    await add('Marketing', 'First');
    await runDailyDispatch({ db, client, config }, { at });

    await add('Marketing', 'Added later');
    await runDailyDispatch(
      { db, client, config }, { at: new Date('2026-09-12T13:00:00Z') }
    );
    expect(posts[2]!.text).toContain('Added later');
  });

  it('does not post the same day twice', async () => {
    const { client, posts } = fakeSlack();
    await add('Marketing', 'Agency work');
    await runDailyDispatch({ db, client, config }, { at });
    const second = await runDailyDispatch({ db, client, config }, { at });
    expect(second.results.every((r) => r.status === 'duplicate')).toBe(true);
    expect(posts).toHaveLength(2);
  });

  it('posts again the next day', async () => {
    const { client, posts } = fakeSlack();
    await add('Marketing', 'Agency work');
    await runDailyDispatch({ db, client, config }, { at });
    await runDailyDispatch(
      { db, client, config }, { at: new Date('2026-09-12T13:00:00Z') }
    );
    expect(posts).toHaveLength(4);
  });

  /** Isolation, in both directions. */
  it('still attempts Personal when Agency throws', async () => {
    await add('Marketing', 'Agency work');
    await add('Personal', 'Personal work');
    const posts: Record<string, unknown>[] = [];
    const client: SlackPoster = {
      chat: {
        postMessage: async (args) => {
          if (args.channel === 'C_AGENCY') throw new Error('channel_not_found');
          posts.push(args);
          return { ts: '1.1' };
        },
      },
    };

    const report = await runDailyDispatch({ db, client, config }, { at });
    expect(report.results[0]).toMatchObject({ key: 'agency-daily', status: 'failed' });
    expect(report.results[1]).toMatchObject({ key: 'personal-daily', status: 'posted' });
    expect(posts.map((p) => p.channel)).toEqual(['C_PERSONAL']);
  });

  it('leaves the Agency post intact when Personal throws', async () => {
    await add('Marketing', 'Agency work');
    await add('Personal', 'Personal work');
    const posts: Record<string, unknown>[] = [];
    const client: SlackPoster = {
      chat: {
        postMessage: async (args) => {
          if (args.channel === 'C_PERSONAL') throw new Error('not_in_channel');
          posts.push(args);
          return { ts: '1.1' };
        },
      },
    };

    const report = await runDailyDispatch({ db, client, config }, { at });
    expect(report.results[0]).toMatchObject({ key: 'agency-daily', status: 'posted' });
    expect(report.results[1]).toMatchObject({ key: 'personal-daily', status: 'failed' });
    expect(posts.map((p) => p.channel)).toEqual(['C_AGENCY']);

    // Agency keeps its claim, so a retry cannot double-post what already went.
    const runs = await recentRuns(db);
    expect(runs.find((r) => r.job_key === 'agency-daily')!.outcome).toBe('posted');
    expect(runs.find((r) => r.job_key === 'personal-daily')).toBeUndefined();
  });

  it('releases only the failed job, so the next run retries just that one', async () => {
    await add('Marketing', 'Agency work');
    const exploding: SlackPoster = {
      chat: { postMessage: async () => { throw new Error('channel_not_found'); } },
    };
    await runDailyDispatch({ db, client: exploding, config }, { at });

    const { client, posts } = fakeSlack();
    const retry = await runDailyDispatch({ db, client, config }, { at });
    expect(retry.results.every((r) => r.status === 'posted')).toBe(true);
    expect(posts).toHaveLength(2);
  });

  it('never lets a token reach the logs', async () => {
    const client: SlackPoster = {
      chat: {
        postMessage: async () => {
          throw new Error('request failed with Bearer xoxb-4242-secret-value');
        },
      },
    };
    const report = await runDailyDispatch({ db, client, config }, { at });
    for (const r of report.results) {
      // Both rules fire; whichever masks it last, the secret is gone.
      expect(r.reason).not.toContain('xoxb-4242-secret-value');
      expect(r.reason).not.toContain('secret-value');
      expect(r.reason).toContain('***');
    }
  });

  it('leaves the ledger untouched on a rehearsal', async () => {
    const rehearsal = fakeSlack();
    await add('Marketing', 'Agency work');
    await runDailyDispatch(
      { db, client: rehearsal.client, config }, { at, rehearsal: true }
    );
    expect(rehearsal.posts).toHaveLength(2);
    expect(await recentRuns(db)).toEqual([]);

    const live = fakeSlack();
    const report = await runDailyDispatch({ db, client: live.client, config }, { at });
    expect(report.results.every((r) => r.status === 'posted')).toBe(true);
  });

  it('lets a manual run post without consuming the scheduled occurrence', async () => {
    const { client, posts } = fakeSlack();
    await add('Marketing', 'Agency work');

    await runJobNow({ db, client, config }, 'agency-daily');
    expect(posts).toHaveLength(1);

    const report = await runDailyDispatch({ db, client, config }, { at });
    expect(report.results[0]!.status).toBe('posted');
  });
});
