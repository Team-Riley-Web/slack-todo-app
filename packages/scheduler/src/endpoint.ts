import { WebClient } from '@slack/web-api';
import type { Db } from '@tr/db';
import { loadSchedulerConfig } from './config.js';
import type { SlackPoster } from './jobs.js';
import { buildCrashAlert, sendAlert } from './alerts.js';
import { runBriefingNow, runWeeklyDispatch, UnknownBriefingError } from './run.js';

/**
 * The credential-reading half of the cron endpoint, kept OUT of
 * `apps/web/src/app`.
 *
 * `apps/web/src/no-secrets.test.ts` greps that directory for secret env names
 * and fails on a hit, because a page that can read a token is a page that can
 * render one. The Slack events route solves the same problem the same way --
 * it delegates to `@tr/slack-app/http` -- and this follows it, so the route
 * handler stays a thin adapter with no credential in reach.
 */
export function createSchedulerSlackClient(
  env: NodeJS.ProcessEnv = process.env
): SlackPoster {
  const token = env.SLACK_BOT_TOKEN?.trim();
  if (!token) throw new Error('SLACK_BOT_TOKEN is not set');
  return new WebClient(token) as unknown as SlackPoster;
}

/**
 * Vercel signs its own cron invocations with CRON_SECRET as a bearer token.
 * The same secret authorizes a manual trigger, so testing a job by hand needs
 * no second credential -- and an unauthenticated request can never make this
 * workspace post to Slack.
 *
 * Lengths are compared first so a wrong-length guess cannot be timed, then
 * every character is compared rather than bailing at the first mismatch.
 * An unset secret denies everything: a deployment that forgot to configure it
 * should post nothing, not accept anyone.
 */
export function authorizeCronRequest(
  authorization: string | null, env: NodeJS.ProcessEnv = process.env
): boolean {
  const secret = env.CRON_SECRET?.trim();
  if (!secret) return false;
  const offered = (authorization ?? '').replace(/^Bearer\s+/i, '');
  if (offered.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i += 1) {
    diff |= secret.charCodeAt(i) ^ offered.charCodeAt(i);
  }
  return diff === 0;
}

export interface ScheduledRequestOptions {
  /** Opened only after the request is authorized. */
  getDb: () => Promise<Db>;
  env?: NodeJS.ProcessEnv;
  client?: SlackPoster;
}

/**
 * One scheduled-delivery request.
 *
 * With no parameters it runs the weekly dispatch: every briefing, each to its
 * own channel, then stop. That is what the Monday Vercel cron calls, and it is
 * idempotent for the week via the ledger.
 *
 * With `?job=<briefing>` -- `agency`, `personal`, or a mapped Space's slug --
 * it runs that ONE briefing immediately, bypassing the ledger: the manual test
 * path. Same handler, same functions; there is no separate test-only
 * scheduling logic to drift.
 */
export async function handleScheduledRequest(
  request: Request, opts: ScheduledRequestOptions
): Promise<Response> {
  const env = opts.env ?? process.env;
  if (!authorizeCronRequest(request.headers.get('authorization'), env)) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const job = url.searchParams.get('job');

  try {
    const deps = {
      db: await opts.getDb(),
      client: opts.client ?? createSchedulerSlackClient(env),
      config: loadSchedulerConfig(env),
    };

    if (job !== null) {
      const result = await runBriefingNow(deps, job);
      return Response.json({ ok: true, manual: true, job, result });
    }
    return Response.json({ ok: true, ...(await runWeeklyDispatch(deps)) });
  } catch (error) {
    if (error instanceof UnknownBriefingError) {
      return Response.json(
        { ok: false, error: error.message, jobs: error.available }, { status: 400 }
      );
    }
    console.error('[scheduler] run failed', error);
    // A crash before any briefing went out is the worst Monday: say so in Slack.
    if (job === null) {
      try {
        await sendAlert(
          opts.client ?? createSchedulerSlackClient(env), loadSchedulerConfig(env),
          buildCrashAlert(error)
        );
      } catch { /* the alert is best effort; the 500 below still reports it */ }
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
