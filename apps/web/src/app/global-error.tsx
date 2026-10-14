'use client';

import { useEffect } from 'react';
import { isStaleDeployError, shouldAutoReload } from '@/lib/recover';

/**
 * The last line of defence, for an error in the root layout itself, where
 * `error.tsx` cannot render. It must draw its own <html> and <body>, and it
 * cannot rely on the app stylesheet, so it is styled inline and kept plain.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    console.error(error);
    let storage: Storage | null = null;
    try { storage = window.sessionStorage; } catch { /* private mode */ }
    if (isStaleDeployError(error) && shouldAutoReload(storage, window.location.pathname)) {
      window.location.reload();
    }
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: 24, color: '#202533' }}>
        <h1 style={{ fontSize: 20 }}>Something went wrong</h1>
        <p>The app was probably updated while this page was open.</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ fontSize: 16, padding: '10px 16px' }}
        >
          Reload
        </button>
      </body>
    </html>
  );
}
