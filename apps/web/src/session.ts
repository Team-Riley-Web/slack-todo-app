export interface WebUser {
  slackUserId: string;
  name: string | null;
}

/**
 * The same allowlist `apps/slack` enforces, so there is exactly one answer to
 * who may act on tasks.
 *
 * Fails closed on an empty list. The Slack app can fall back to a workspace
 * check because its payloads carry a team id; the web app cannot, because
 * Auth.js does not document the Slack profile's shape. So an unconfigured
 * allowlist must deny everyone rather than admit everyone.
 */
export function authorizeSlackUser(
  slackUserId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!slackUserId) return false;
  const allowed = (env.AUTHORIZED_SLACK_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return false;
  return allowed.includes(slackUserId.trim());
}

/**
 * Local sign-in bypass.
 *
 * Slack requires the OAuth redirect URL to use https even in development, so
 * signing in on plain localhost is impossible without a tunnel. This supplies
 * an identity instead.
 *
 * BOTH conditions are required: a non-production environment AND an explicit
 * variable. A test asserts this returns null under NODE_ENV=production even
 * when WEB_DEV_USER is set, because a dev bypass that survives into production
 * is the whole risk.
 *
 * It supplies an identity, not authority — the caller still runs the result
 * through authorizeSlackUser.
 */
export function devUser(env: NodeJS.ProcessEnv = process.env): WebUser | null {
  if (env.NODE_ENV === 'production') return null;
  const id = env.WEB_DEV_USER?.trim();
  if (!id) return null;
  return { slackUserId: id, name: 'Local development user' };
}
