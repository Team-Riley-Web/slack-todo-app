import Link from 'next/link';

export function Nav({ current, who }: { current: string; who: string | null }) {
  const item = (href: string, label: string) => (
    <Link href={href} aria-current={current === href ? 'page' : undefined}>
      {label}
    </Link>
  );
  return (
    <nav className="top">
      {item('/', 'My tasks')}
      {item('/spaces', 'Spaces')}
      {item('/waiting', 'Waiting')}
      {item('/history', 'History')}
      {item('/settings', 'Settings')}
      <span className="spacer" />
      {who ? <span className="who">{who}</span> : null}
    </nav>
  );
}
