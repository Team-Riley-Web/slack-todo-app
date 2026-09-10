import { signIn } from '@/auth';
import { currentUser } from '@/user';
import { redirect } from 'next/navigation';

export default async function SignInPage() {
  if (await currentUser()) redirect('/');

  return (
    <main className="narrow">
      <h1>Team Riley Tasks</h1>
      <p className="muted">Sign in with the Slack account you use for tasks.</p>
      <form
        action={async () => {
          'use server';
          await signIn('slack', { redirectTo: '/' });
        }}
      >
        <button type="submit" className="primary">Sign in with Slack</button>
      </form>
      <p className="muted small">
        Access is limited to the people listed in the app configuration. If you
        get sent back here after signing in, your Slack account is not on that
        list.
      </p>
    </main>
  );
}
