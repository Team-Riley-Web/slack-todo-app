import Image from 'next/image';
import { signIn } from '@/auth';
import { currentUser } from '@/user';
import { redirect } from 'next/navigation';

/**
 * The Slack mark, inline and local to this page.
 *
 * Not in Icon.tsx: every glyph in that set is one stroked path on a 24 grid,
 * and this is four filled lozenges on Slack's own 122.8 grid. Putting a brand
 * mark in the app's icon set would mean the set no longer has one shape.
 *
 * `currentColor`, so it takes the button's white rather than Slack's four
 * colours. The mark stays recognisable in a single colour, and the four-colour
 * version on the accent fill would be the only multicoloured thing in the
 * interface -- Slack's guidelines allow the white mark on a coloured ground.
 */
function SlackMark() {
  return (
    <svg viewBox="0 0 122.8 122.8" aria-hidden="true" focusable="false">
      <path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" />
      <path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" />
      <path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" />
      <path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" />
    </svg>
  );
}

/**
 * Sign in.
 *
 * The one page with no rail -- you cannot navigate before you are in -- so it
 * borrows the rail's header instead. The card's top band is the workspace
 * header: same graphite, same logo at the same radius, same team name at 650.
 * That strip is the most recognisable part of the app, and reusing it is what
 * makes this read as the same product rather than a form on a blank page.
 */
export default async function SignInPage() {
  if (await currentUser()) redirect('/');

  return (
    <main className="signin">
      <div className="signin-card">
        <div className="signin-brand">
          <Image src="/tasks-logo.png" alt="" width={40} height={40} priority />
          <h1>Team Riley Tasks</h1>
        </div>
        <div className="signin-body">
          <p className="muted">Sign in with the Slack account you use for tasks.</p>
          <form
            action={async () => {
              'use server';
              await signIn('slack', { redirectTo: '/' });
            }}
          >
            <button type="submit" className="primary slack">
              <SlackMark />
              Sign in with Slack
            </button>
          </form>
        </div>
        <p className="signin-note small">
          Access is limited to the people listed in the app configuration. If you
          get sent back here after signing in, your Slack account is not on that
          list.
        </p>
      </div>
    </main>
  );
}
