import 'dotenv/config';
import { createDb, migrate } from '@tr/db';
import {
  createSchedulerSlackClient, loadSchedulerConfig, localMoment, recentRuns,
  runDailyDispatch, runJobNow, planTaskMessages,
  getAllOpenAgencyTasks, getAllOpenPersonalTasks,
  JOB_KEYS, type JobKey, type SlackPoster,
} from '@tr/scheduler';

/**
 * Manual driver for the daily Slack posts.
 *
 *   pnpm scheduled status              config, and what has run lately
 *   pnpm scheduled preview <job>       render to the terminal, post nothing
 *   pnpm scheduled run <job>           post that one list to Slack now
 *   pnpm scheduled dispatch [--dry-run]  run the WHOLE daily dispatch
 *
 * `run` and `dispatch` both call the production handler. `run` bypasses the
 * ledger, so testing at 2pm does not consume tomorrow morning's delivery;
 * `dispatch` honours it, so it is the honest rehearsal — with `--dry-run` it
 * prints instead of posting AND leaves the ledger untouched.
 */
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function usage(): never {
  console.error(
    'usage:\n' +
    '  pnpm scheduled status\n' +
    '  pnpm scheduled preview <job>\n' +
    '  pnpm scheduled run <job>\n' +
    '  pnpm scheduled dispatch [--at 2026-09-11T13:05:00Z] [--dry-run]\n' +
    `\njobs: ${JOB_KEYS.join(', ')}`
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
const command = argv[0];
if (!command) usage();

const config = loadSchedulerConfig();
const db = await createDb();
await migrate(db);

/** Prints instead of sending. `preview` and `--dry-run` never touch Slack. */
const dryRunClient: SlackPoster = {
  chat: {
    postMessage: async (args) => {
      console.log(`\n--- would post to ${String(args.channel)} ---`);
      console.log(args.text);
      console.log(`(${(args.blocks as unknown[] | undefined)?.length ?? 0} blocks)`);
      return { ts: undefined };
    },
  },
};

function liveClient(): SlackPoster {
  try {
    return createSchedulerSlackClient();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error('Nothing can be posted. Use --dry-run to render instead.');
    process.exit(1);
  }
}

function assertJob(name: string | undefined): JobKey {
  if (!name || !JOB_KEYS.includes(name as JobKey)) usage();
  return name as JobKey;
}

try {
  if (command === 'status') {
    const now = localMoment(new Date(), config.timeZone);
    console.log(`local time     ${now.date} ${String(now.hour).padStart(2, '0')}:${
      String(now.minute).padStart(2, '0')} ${config.timeZone}`);
    console.log(`agency channel ${config.agencyChannelId || '(unset)'}`);
    console.log(`personal chan. ${config.personalChannelId || '(unset)'}`);
    console.log('schedule       once daily, 13:00 UTC (Vercel cron `0 13 * * *`)');
    const runs = await recentRuns(db, 15);
    console.log('\nrecent runs');
    if (runs.length === 0) console.log('  (none yet)');
    for (const r of runs) {
      console.log(`  ${r.occurrence}  ${r.job_key.padEnd(15)} ${r.outcome.padEnd(8)} ${
        JSON.stringify(r.detail ?? {})}`);
    }
  } else if (command === 'preview') {
    const job = assertJob(argv[1]);
    const agency = job === 'agency-daily';
    const tasks = agency
      ? await getAllOpenAgencyTasks(db, config)
      : await getAllOpenPersonalTasks(db, config);
    const heading = agency ? 'Agency Tasks — Today' : 'Personal Tasks — Today';
    const planned = planTaskMessages(heading, tasks.groups, {
      timeZone: config.timeZone, assigneeLabels: config.assigneeLabels,
    });
    console.log(`${tasks.entries.length} open task(s) across ${
      tasks.groups.length} space(s), in ${planned.length} message(s):\n`);
    for (const [i, m] of planned.entries()) {
      console.log(`--- message ${i + 1} (${m.blocks.length} blocks) ---`);
      console.log(m.text);
      console.log();
    }
  } else if (command === 'run') {
    const job = assertJob(argv[1]);
    const dry = argv.includes('--dry-run');
    const result = await runJobNow(
      { db, client: dry ? dryRunClient : liveClient(), config }, job
    );
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'dispatch') {
    const at = flag(argv, 'at');
    const when = at ? new Date(at) : new Date();
    if (Number.isNaN(when.getTime())) {
      console.error(`--at "${at}" is not a date`);
      process.exit(1);
    }
    // --dry-run means rehearse: print instead of posting, AND leave the ledger
    // untouched, so rehearsing today does not consume the real delivery.
    const dry = argv.includes('--dry-run');
    const report = await runDailyDispatch(
      { db, client: dry ? dryRunClient : liveClient(), config },
      { at: when, rehearsal: dry }
    );
    console.log(JSON.stringify(report, null, 2));
  } else {
    usage();
  }
} finally {
  await db.close();
}
