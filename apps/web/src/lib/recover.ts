/**
 * Whether an error is the "this page is older than the deployment" kind, which
 * a reload fixes.
 *
 * A page loaded before a deploy still holds the previous build's server-action
 * ids and script chunk names. Its next form submission or navigation asks the
 * new deployment for things it no longer has, and Next surfaces that as a bare
 * "Application error: a client-side exception has occurred" -- which is what
 * a New task save looked like on 2026-10-14, minutes after a push.
 */
export function isStaleDeployError(error: { message?: string; name?: string } | null): boolean {
  if (!error) return false;
  const text = `${error.name ?? ''} ${error.message ?? ''}`;
  return /Failed to find Server Action|Server Action .* was not found|ChunkLoadError|Loading chunk [\w-]+ failed|Failed to fetch dynamically imported module|older or newer deployment/i
    .test(text);
}

/**
 * At most one automatic reload per page in a 30-second window, so an error a
 * reload does NOT fix shows its screen instead of reloading forever. Storage
 * can be unavailable (private mode); then nothing reloads automatically and
 * the screen's own Reload button still works.
 */
export function shouldAutoReload(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null, path: string, now = Date.now()
): boolean {
  if (!storage) return false;
  const key = `tr-reloaded:${path}`;
  try {
    const last = Number(storage.getItem(key) ?? 0);
    if (now - last < 30_000) return false;
    storage.setItem(key, String(now));
    return true;
  } catch {
    return false;
  }
}
