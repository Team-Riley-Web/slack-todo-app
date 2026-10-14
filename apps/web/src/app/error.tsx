'use client';

import { useEffect } from 'react';
import { isStaleDeployError, shouldAutoReload } from '@/lib/recover';

/**
 * What a page shows instead of Next's bare "Application error" screen.
 *
 * The common cause is a page that outlived a deployment (see recover.ts), and
 * a reload is the whole fix -- so that case reloads by itself, once. Anything
 * else gets a plain screen with a Reload button. A save that failed this way
 * may or may not have reached the database, so the screen says to check
 * rather than to try again blindly.
 */
export default function ErrorScreen({
  error, reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
    let storage: Storage | null = null;
    try { storage = window.sessionStorage; } catch { /* private mode */ }
    if (isStaleDeployError(error) && shouldAutoReload(storage, window.location.pathname)) {
      window.location.reload();
    }
  }, [error]);

  return (
    <main className="error-screen">
      <h1>Something went wrong</h1>
      <p>
        The app was probably updated while this page was open. Reload to pick
        up the new version. If you were saving a task, check the list before
        adding it again: it may already be there.
      </p>
      <div className="filters">
        <button type="button" className="primary" onClick={() => window.location.reload()}>
          Reload
        </button>
        <button type="button" onClick={() => reset()}>Try again</button>
      </div>
    </main>
  );
}
