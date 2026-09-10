import NextAuth from 'next-auth';
import Slack from 'next-auth/providers/slack';

/**
 * Sign in with Slack.
 *
 * Env names are fixed by Auth.js: AUTH_SLACK_ID, AUTH_SLACK_SECRET, AUTH_SECRET.
 * The callback URL is /api/auth/callback/slack and Slack requires it to be
 * https even in development — see WEB.md for the local path.
 *
 * JWT sessions, so there is no session table to migrate or clean up.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Slack],
  session: { strategy: 'jwt' },
  callbacks: {
    /**
     * Slack's user id arrives as the account's providerAccountId. Nothing here
     * reads any other profile field: Auth.js does not document the Slack
     * profile's shape, and building on an undocumented field is how this breaks
     * quietly later.
     */
    jwt({ token, account }) {
      if (account?.providerAccountId) {
        (token as { slackUserId?: string }).slackUserId = account.providerAccountId;
      }
      return token;
    },
    session({ session, token }) {
      (session as { slackUserId?: string }).slackUserId =
        (token as { slackUserId?: string }).slackUserId;
      return session;
    },
  },
});
