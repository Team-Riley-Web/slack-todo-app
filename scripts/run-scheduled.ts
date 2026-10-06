import 'dotenv/config';
import { createDb, migrate } from '@tr/db';
import {
  createSchedulerSlackClient, loadSchedulerConfig, localMoment, recentRuns,
  runWeeklyDispatch, runBriefingNow, loadBriefingPlan, findBriefing,
  getOpenTasks, tasksForBriefing, focusGroups, hiddenFooter, briefingHeading,
  planTaskMessages, UnknownBriefingError, WEEKLY_CRON,
  type SlackPoster,
} from '@tr/scheduler';

/**
 * Manual driver for the weekly Slack briefings.
 *
 *   pnpm scheduled status                 routing, config, and recent runs
 *   pnpm scheduled preview <briefing>     render to the terminal, post nothing
 *   pnpm scheduled run <briefing>         post that one briefing to Slack now
 *   pnpm scheduled dispatch [--dry-run]   run the WHOLE weekly dispatch
 *
 * A briefing is `agency`, `personal`, or a mapped Space's slug.
 *
 * `run` and `dispatch` both call the production handler. `run` bypasses the
 * ledger, so a test post does not consume this week's delivery; `dispatch`
 * honours it, so it is the honest rehearsal — with `--dry-run` it prints
 * instead of posting AND leaves the ledger untouched.
 */
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function usage(): never {
  console.error(
    'usage:\n' +
    '  pnpm scheduled status\n' +
    '  pnpm scheduled preview <briefing>\n' +
    '  pnpm scheduled run <briefing> [--dry-run]\n' +
    '  pnpm scheduled dispatch [--at 2026-10-05T13:05:00Z] [--dry-run]\n' +
    '\nbriefings: agency, personal, or a mapped Space slug (see `status`)'
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

try {
  if (command === 'status') {
    const now = localMoment(new Date(), config.timeZone);
    console.log(`local time     ${now.date} ${String(now.hour).padStart(2, '0')}:${
      String(now.minute).padStart(2, '0')} ${config.timeZone} (week of ${now.week})`);
    console.log(`schedule       weekly, Mondays 13:00 UTC (Vercel cron \`${WEEKLY_CRON}\`)`);
    console.log(`top per Space  ${config.topPerSpace}`);

    const plan = await loadBriefingPlan(db, config);
    console.log('\nbriefings');
    for (const b of plan.briefings) {
      console.log(`  ${b.name.padEnd(22)} -> ${(b.channelId ?? '(unset)').padEnd(13)} ${
        b.spaces.map((s) => s.name).join(', ') || '(no Spaces)'}`);
    }
    if (plan.unrouted.length > 0) {
      console.log('\nnot briefed');
      for (const u of plan.unrouted) {
        console.log(`  ${u.space.name}: ${u.reason}`);
      }
    }

    const runs = await recentRuns(db, 20);
    console.log('\nrecent runs');
    if (runs.length === 0) console.log('  (none yet)');
    for (const r of runs) {
      console.log(`  ${r.occurrence}  ${r.job_key.padEnd(24)} ${r.outcome.padEnd(8)} ${
        JSON.stringify(r.detail ?? {})}`);
    }
  } else if (command === 'preview') {
    const name = argv[1];
    if (!name) usage();
    const plan = await loadBriefingPlan(db, config);
    const briefing = findBriefing(plan, name);
    if (!briefing) {
      throw new UnknownBriefingError(name, plan.briefings.map((b) => b.name));
    }
    const week = localMoment(new Date(), config.timeZone).week;
    const tasks = tasksForBriefing(briefing, await getOpenTasks(db));
    const { groups, hidden } = focusGroups(tasks.groups, config.topPerSpace);
    const planned = planTaskMessages(
      briefingHeading(briefing, week), groups,
      { timeZone: config.timeZone, assigneeLabels: config.assigneeLabels },
      hiddenFooter(hidden)
    );
    console.log(`${tasks.entries.length} open task(s) across ${tasks.groups.length} ` +
      `Space(s) -> ${briefing.channelId ?? '(no channel)'}, in ${planned.length} message(s):\n`);
    for (const [i, m] of planned.entries()) {
      console.log(`--- message ${i + 1} (${m.blocks.length} blocks) ---`);
      console.log(m.text);
      console.log();
    }
  } else if (command === 'run') {
    const name = argv[1];
    if (!name) usage();
    const dry = argv.includes('--dry-run');
    const result = await runBriefingNow(
      { db, client: dry ? dryRunClient : liveClient(), config }, name
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
    // untouched, so rehearsing does not consume the real delivery.
    const dry = argv.includes('--dry-run');
    const report = await runWeeklyDispatch(
      { db, client: dry ? dryRunClient : liveClient(), config },
      { at: when, rehearsal: dry }
    );
    console.log(JSON.stringify(report, null, 2));
  } else {
    usage();
  }
} catch (error) {
  if (error instanceof UnknownBriefingError) {
    console.error(`${error.message}. Briefings: ${error.available.join(', ')}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await db.close();
}
