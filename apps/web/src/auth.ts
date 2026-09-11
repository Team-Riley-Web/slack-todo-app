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
 *
 * On a phone this always opens the Slack WEBSITE, never the Slack app. That is
 * Slack's design: OAuth runs in the browser and the installed app cannot hand
 * its session to a web app. The two settings below are what can actually be
 * controlled — skip the workspace picker, and sign in rarely.
 */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Slack({
      /*
       * Pins the workspace, so Slack never asks which one. This is a
       * single-workspace app -- `authorize` in the Slack app already rejects
       * any other team -- so being asked was a question with one answer.
       *
       * Omitted when SLACK_TEAM_ID is unset rather than sent empty: Slack
       * rejects `team=` outright, which would break sign-in entirely.
       */
      authorization: process.env.SLACK_TEAM_ID?.trim()
        ? { params: { team: process.env.SLACK_TEAM_ID.trim() } }
        : undefined,
    }),
  ],
  /*
   * A year, set explicitly rather than left to the 30-day default.
   *
   * The cost of a long session here is low: the JWT only carries a Slack user
   * id, every page re-checks it against AUTHORIZED_SLACK_USER_IDS on each
   * request, and revoking access is an env-var change that takes effect
   * immediately -- it does not wait for a session to expire. The benefit is
   * that a phone kept on the home screen stays signed in instead of bouncing
   * to Slack's website every few weeks.
   */
  session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_SECONDS },
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
