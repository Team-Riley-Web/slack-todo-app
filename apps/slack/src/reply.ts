/**
 * Talking back to whoever ran a slash command.
 *
 * The bug this exists for: `/task` in a channel the app had not been invited
 * to created the task, then threw on `chat.postMessage` with
 * `not_in_channel`. `/space` was worse -- its confirmation was wrapped in a
 * bare `catch {}` so nothing was raised at all. Either way the person saw
 * absolute silence and reasonably concluded nothing had happened, while the
 * database said otherwise.
 *
 * `chat.postEphemeral` cannot fix that: it needs channel membership too. A
 * slash command's `response_url` does not -- responding to a command is
 * exactly what Slack provides it for, and it works in a channel the app has
 * never joined. So it is the primary path here, with `postEphemeral` kept as
 * the fallback for callers that have no response_url (the modal submits, and
 * every test that constructs deps by hand).
 *
 * Limits worth knowing: a response_url is good for 30 minutes and five uses.
 * Both are far beyond what one command needs, and neither is worth tracking.
 */

export interface RespondArgs {
  text: string;
  response_type?: 'ephemeral' | 'in_channel';
  blocks?: unknown[];
}

/** Bolt hands this to every command listener. */
export type Respond = (args: RespondArgs) => Promise<unknown>;

export interface ReplyDeps {
  /** Absent on modal submits, which get no response_url from Slack. */
  respond?: Respond;
  client: {
    chat: { postEphemeral: (args: Record<string, unknown>) => Promise<unknown> };
  };
}

/**
 * Slack error codes that mean "this app cannot post in that conversation".
 *
 * Kept as a set rather than a `not_in_channel` check because the outcome, and
 * the sentence the person needs to read, is the same for all of them.
 */
const CANNOT_POST = new Set([
  'not_in_channel',
  'channel_not_found',
  'is_archived',
  'restricted_action',
  'org_restricted_action',
]);

/**
 * The Slack error code inside a thrown WebAPI error, if there is one.
 *
 * Bolt throws a `WebAPIPlatformError` carrying `data.error`, but a raw fetch
 * wrapper or a test double may throw something flatter, so both shapes are
 * read rather than assuming one.
 */
export function slackErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const e = error as { data?: { error?: unknown }; error?: unknown };
  const code = e.data?.error ?? e.error;
  return typeof code === 'string' ? code : null;
}

/** True when the failure is "not allowed to post here", not a real fault. */
export function isCannotPostError(error: unknown): boolean {
  const code = slackErrorCode(error);
  return code !== null && CANNOT_POST.has(code);
}

/**
 * Tell one person something, privately.
 *
 * Never throws: a confirmation that cannot be delivered must not undo work
 * that already succeeded. But unlike the `catch {}` this replaces, a total
 * failure is logged, so silence leaves a trace somewhere.
 */
export async function replyPrivately(
  deps: ReplyDeps,
  target: { channelId: string; userId: string | null },
  text: string
): Promise<void> {
  if (deps.respond) {
    try {
      // Ephemeral is response_url's default, and a confirmation is not news
      // the whole channel needs.
      await deps.respond({ text, response_type: 'ephemeral' });
      return;
    } catch (error) {
      console.error('[slack] response_url reply failed, trying ephemeral', error);
    }
  }

  if (!target.userId) return;
  try {
    await deps.client.chat.postEphemeral({
      channel: target.channelId, user: target.userId, text,
    });
  } catch (error) {
    console.error('[slack] could not deliver a reply to the user', error);
  }
}

/**
 * The sentence to send when a card cannot be posted into the channel.
 *
 * The work is already saved, so this says so first -- the failure people
 * report is thinking the task vanished -- and then gives the one action that
 * fixes it. `channelName` arrives from Slack without a leading '#'.
 */
export function cannotPostHere(
  what: string, channelName: string | undefined
): string {
  const where = channelName ? `#${channelName}` : 'this channel';
  return (
    `${what}\n\n` +
    `I could not post it in ${where} because this app is not in that channel. ` +
    `Invite it (type \`/invite\` in ${where} and pick this app) and cards will ` +
    `appear there from then on. Everything is saved either way, and the web UI ` +
    `shows it now.`
  );
}
