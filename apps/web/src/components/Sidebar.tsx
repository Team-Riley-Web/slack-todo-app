import Link from 'next/link';
import Image from 'next/image';
import type { Space } from '@tr/task-core';
import { shortSpaceName, isClientSpace } from '@/lib/display';
import { Icon, type IconName } from './Icon';

export interface SidebarSpace {
  space: Space;
  open: number;
  waiting: number;
}

/**
 * The sidebar, carrying the whole navigation.
 *
 * Clients get their own group. It is derived from the "Client - " prefix
 * rather than a flag on the Space, so nothing has to be maintained: name a
 * Space "Client - X" and it sorts itself into Clients. That is also why
 * `createSpace` does not add the prefix for you — the prefix is the signal.
 */
export function Sidebar({
  spaces, activeSlug, current, path, who,
}: {
  spaces: SidebarSpace[];
  activeSlug: string | null;
  current: string;
  path: string;
  who: string | null;
}) {
  const spaceHref = (slug: string | null) =>
    slug === null ? path : `${path}?space=${encodeURIComponent(slug)}`;

  const navItem = (href: string, label: string, icon: IconName) => (
    <li key={href}>
      <Link href={href} aria-current={current === href ? 'page' : undefined}>
        <Icon name={icon} />
        <span className="label">{label}</span>
      </Link>
    </li>
  );

  const spaceItem = (
    { space, open }: SidebarSpace, icon: IconName
  ) => (
    <li key={space.id}>
      <Link
        href={spaceHref(space.slug)}
        aria-current={activeSlug === space.slug ? 'page' : undefined}
      >
        <Icon name={icon} />
        <span className="label">{shortSpaceName(space)}</span>
        {open > 0 ? <span className="count">{open}</span> : null}
      </Link>
    </li>
  );

  const clients = spaces.filter((s) => isClientSpace(s.space));
  const internal = spaces.filter((s) => !isClientSpace(s.space));
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
        {navItem('/', 'My tasks', 'check')}
        {navItem('/today', 'Due today', 'calendar')}
        {navItem('/waiting', 'Waiting', 'pause')}
        {navItem('/history', 'Completed', 'done')}
      </ul>

      <p className="group-head">Spaces</p>
      <ul className="group space-list">
        <li>
          <Link href={spaceHref(null)} aria-current={activeSlug === null ? 'page' : undefined}>
            <Icon name="space" />
            <span className="label">All spaces</span>
            {total > 0 ? <span className="count">{total}</span> : null}
          </Link>
        </li>
        {internal.map((s) => spaceItem(s, 'space'))}
      </ul>

      {clients.length > 0 ? (
        <>
          <p className="group-head">Clients</p>
          <ul className="group space-list">
            {clients.map((s) => spaceItem(s, 'client'))}
          </ul>
        </>
      ) : null}

      <span className="grow" />
      <ul className="group foot">
        {navItem('/spaces', 'Spaces', 'space')}
        {navItem('/settings', 'Settings', 'cog')}
      </ul>
    </nav>
  );
}
