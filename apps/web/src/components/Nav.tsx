import Link from 'next/link';
import Image from 'next/image';

/**
 * The top bar.
 *
 * Logo and workspace name sit top-left, where Workast puts them above its
 * sidebar. They live in this bar rather than in the rail because the rail is
 * absent on Settings and on the edit pane, and an identity that disappears on
 * some pages is worse than one that never moves.
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
      <Link className="brand" href="/">
        {/* Fixed width and height, so the row cannot reflow as it loads. */}
        <Image
          src="/tasks-logo.png"
          alt=""
          width={26}
          height={26}
          priority
        />
        <span>Team Riley</span>
      </Link>
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
