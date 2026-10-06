import type { SchedulerConfig } from './config.js';
import type { JobRunReport } from './run.js';
import type { SlackPoster } from './jobs.js';

/**
 * When a weekly run goes wrong, say so in Slack -- in #agency-ops, or a direct
 * message from the bot when #agency-ops is itself the problem -- instead of
 * leaving it in a log nobody reads on a Monday morning.
 *
 * Only real problems alert: a post that failed, or open work in a Space that
 * cannot be routed. A quiet client channel is not one.
 */

/** A plain-language cause and fix for the Slack errors that actually happen. */
export function explain(reason: string | undefined): string {
  const r = reason ?? '';
  if (/not_in_channel/.test(r)) {
    return 'the bot is not in that (private) channel. Run `/invite @Tasks` there.';
  }
  if (/channel_not_found/.test(r)) {
    return 'that channel no longer exists or the id is wrong. Re-run `/map` for the Space.';
  }
  if (/is_archived/.test(r)) {
    return 'that channel is archived. Unarchive it, or `/map` the Space to a live one.';
  }
  if (/missing_scope/.test(r)) {
    return 'the Slack app is missing a permission. Add the scope, then reinstall the app.';
  }
  if (/invalid_auth|token_revoked|account_inactive|not_authed/.test(r)) {
    return 'the bot token is no longer valid. Update `SLACK_BOT_TOKEN` in Vercel and redeploy.';
  }
  if (/ratelimited/.test(r)) {
    return 'Slack rate-limited the post. Re-running shortly will pick it up.';
  }
  return r ? `\`${r.slice(0, 200)}\`` : 'unknown error.';
}

export interface AlertMessage {
  text: string;
  /** True when the Agency briefing itself failed, so #agency-ops is not a safe place to say so. */
  agencyBroken: boolean;
}

/** The warning for a finished run, or null when nothing went wrong. */
export function buildRunAlert(
  results: readonly JobRunReport[], week: string, config: SchedulerConfig
): AlertMessage | null {
  const failed = results.filter((r) => r.status === 'failed');
  const unrouted = results.filter((r) => r.status === 'unrouted');
  if (failed.length === 0 && unrouted.length === 0) return null;

  const lines: string[] = [];
  for (const r of failed) {
    const where = r.channel ? ` (<#${r.channel}>)` : '';
    lines.push(`• *${r.key}*${where} didn't post: ${explain(r.reason)}`);
  }
  for (const r of unrouted) {
    lines.push(`• *${r.key}* has ${r.taskCount ?? 0} open task(s) not briefed: ${r.reason ?? 'no safe channel'}.`);
  }
  const n = failed.length + unrouted.length;
  const text = [
    `:warning: *Weekly task briefing: ${n} problem${n === 1 ? '' : 's'}* (week of ${week})`,
    ...lines,
    failed.length > 0
      ? 'Everything else posted normally. After fixing, run `pnpm scheduled dispatch`; only the failed ones retry.'
      : 'Everything else posted normally.',
  ].join('\n');

  const agencyBroken = failed.some(
    (r) => r.key === 'agency' || (!!config.agencyChannelId && r.channel === config.agencyChannelId)
  );
  return { text, agencyBroken };
}

/** A whole-run crash (database down, bad config): nothing was posted at all. */
export function buildCrashAlert(error: unknown): AlertMessage {
  const message = error instanceof Error ? error.message : String(error);
  return {
    text: [
      ':rotating_light: *Weekly task briefings did not run*',
      `The run crashed before posting anything: \`${message.slice(0, 300)}\``,
      'Check the Vercel logs for `/api/cron/scheduled`, fix it, then run `pnpm scheduled dispatch`.',
    ].join('\n'),
    agencyBroken: false,
  };
}

/**
 * Posts the alert to #agency-ops, and falls back to a DM from the bot (to the
 * configured owner) if that channel is where things broke or the post fails.
 * Never throws: an alert about a failure must not become a second failure.
 */
export async function sendAlert(
  client: Pick<SlackPoster, 'chat'>, config: SchedulerConfig, alert: AlertMessage
): Promise<'channel' | 'dm' | 'none'> {
  const post = (channel: string) =>
    client.chat.postMessage({ channel, text: alert.text, unfurl_links: false });

  if (config.agencyChannelId && !alert.agencyBroken) {
    try { await post(config.agencyChannelId); return 'channel'; } catch { /* fall through to the DM */ }
  }
  if (config.alertUserId) {
    try { await post(config.alertUserId); return 'dm'; } catch { /* nothing left to try */ }
  }
  console.error('[scheduler] could not deliver the failure alert to Slack:', alert.text);
  return 'none';
}
