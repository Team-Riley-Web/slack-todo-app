/**
 * Where to land after Slack sign-in.
 *
 * Only an OAuth authorize URL on this site is honoured. Anything else — another
 * host, `//evil.example`, a backslash trick, a different path — falls back to
 * `/`, so `?next=` cannot be used as an open redirect.
 */
export function safeNext(next: string | string[] | undefined): string {
  const value = Array.isArray(next) ? next[0] : next;
  return value && /^\/oauth\/authorize\?[^\s\\]*$/.test(value) ? value : '/';
}
