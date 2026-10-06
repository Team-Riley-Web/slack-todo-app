import type { OAuthDeps } from '@tr/mcp/oauth';
import { currentUser } from '@/user';
import { authorizeSlackUser } from '@/session';

/**
 * What the connector sign-in borrows from the web app: who is signed in, and
 * who may act on tasks. Both are the SAME functions the pages use, so there is
 * still exactly one answer to "is this person allowed".
 */
export const oauthDeps: Pick<OAuthDeps, 'getUser' | 'isAllowed'> = {
  getUser: currentUser,
  isAllowed: (slackUserId) => authorizeSlackUser(slackUserId),
};
