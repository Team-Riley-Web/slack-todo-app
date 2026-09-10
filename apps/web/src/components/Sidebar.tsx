import Link from 'next/link';
import Image from 'next/image';
import type { Space } from '@tr/task-core';
import { shortSpaceName } from '@/lib/display';

export interface SidebarSpace {
  space: Space;
  open: number;
  waiting: number;
}

/**
 * The sidebar, carrying the whole navigation.
 *
 * This is the structural correction: Workast has no full-width top bar. The
 * workspace identity, the cross-Space views, and the Space list all live in
 * one dark rail down the left, and the main column is nothing but content.
 * The previous version split them — a top bar for views, a light rail for
 * Spaces — which is why it never read like the reference however the colours
 * were tuned.
 */
export function Sidebar({
  spaces, activeSlug, current, path, who,
}: {
  spaces: SidebarSpace[];
  /** The Space currently filtered to, or null for all of them. */
  activeSlug: string | null;
  /** Which top-level view is active, for the nav group. */
  current: string;
  /** Which view the Space links should filter. */
  path: string;
  who: string | null;
}) {
  const spaceHref = (slug: string | null) =>
    slug === null ? path : `${path}?space=${encodeURIComponent(slug)}`;

  const navItem = (href: string, label: string) => (
    <li key={href}>
      <Link href={href} aria-current={current === href ? 'page' : undefined}>
        <span className="label">{label}</span>
      </Link>
    </li>
  );

  const spaceItem = (
    key: string, label: string, slug: string | null, count: number
  ) => (
    <li key={key}>
      <Link
        href={spaceHref(slug)}
        aria-current={activeSlug === slug ? 'page' : undefined}
      >
        <span className="label">{label}</span>
        {count > 0 ? <span className="count">{count}</span> : null}
      </Link>
    </li>
  );

  const total = spaces.reduce((n, s) => n + s.open, 0);

  return (
    <nav className="rail" aria-label="Navigation">
      <Link className="workspace" href="/">
        <Image src="/tasks-logo.png" alt="" width={30} height={30} priority />
        <span className="names">
          <span className="team">Team Riley</span>
          {who ? <span className="who">{who}</span> : null}
        </span>
      </Link>

      <ul className="group">
        {navItem('/', 'My tasks')}
        {navItem('/today', 'Due today')}
        {navItem('/waiting', 'Waiting')}
        {navItem('/history', 'Completed')}
      </ul>

      <p className="group-head">Spaces</p>
      <ul className="group space-list">
        {spaceItem('__all__', 'All spaces', null, total)}
        {spaces.map((s) =>
          spaceItem(s.space.id, shortSpaceName(s.space), s.space.slug, s.open)
        )}
      </ul>

      <span className="grow" />
      <ul className="group foot">
        {navItem('/spaces', 'Manage spaces')}
        {navItem('/settings', 'Settings')}
      </ul>
    </nav>
  );
}
