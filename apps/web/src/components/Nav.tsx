import Link from 'next/link';

/**
 * The top bar.
 *
 * Spaces are deliberately NOT here: they are the left rail, and listing them
 * twice was the clutter this replaces. What stays is the handful of views that
 * cut across every Space.
 */
export function Nav({ current, who }: { current: string; who: string | null }) {
  const item = (href: string, label: string) => (
    <Link
      key={href}
      href={href}
      aria-current={current === href ? 'page' : undefined}
    >
      {label}
    </Link>
  );
  return (
    <nav className="top">
      <span className="brand">Tasks</span>
      <span className="links">
        {item('/', 'My tasks')}
        {item('/today', 'Due today')}
        {item('/waiting', 'Waiting')}
        {item('/history', 'Completed')}
      </span>
      <span className="spacer" />
      {who ? <span className="who">{who}</span> : null}
      {item('/settings', 'Settings')}
    </nav>
  );
}
