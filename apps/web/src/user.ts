import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { authorizeSlackUser, devUser, type WebUser } from '@/session';

export type { WebUser } from '@/session';

/**
 * The signed-in, authorized user, or null.
 *
 * Checks the development bypass first, then the Auth.js session. Either way the
 * identity is run through `authorizeSlackUser`, so an unlisted user is not
 * signed in as far as this app is concerned.
 */
export async function currentUser(): Promise<WebUser | null> {
  const dev = devUser();
  if (dev) return authorizeSlackUser(dev.slackUserId) ? dev : null;

  const session = await auth();
  const slackUserId = (session as { slackUserId?: string } | null)?.slackUserId;
  if (!authorizeSlackUser(slackUserId)) return null;
  return {
    slackUserId: slackUserId!,
    name: session?.user?.name ?? null,
  };
}

/** For pages. Redirects rather than rendering anything to an unauthorized visitor. */
export async function requireUser(): Promise<WebUser> {
  const user = await currentUser();
  if (!user) redirect('/signin');
  return user;
}
