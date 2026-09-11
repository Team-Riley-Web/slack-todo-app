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
  spaces, activeSlug, current,
}: {
  spaces: SidebarSpace[];
  activeSlug: string | null;
  current: string;
}) {
  /*
   * A Space link always opens My tasks for that Space.
   *
   * It used to keep whichever report you were on, so clicking Agency from
   * Waiting opened Waiting-in-Agency: empty, beside a rail that said Agency
   * had six tasks. Choosing a Space is choosing where to look, not narrowing
   * the report you happened to be reading.
   */
  const spaceHref = (slug: string | null) =>
    slug === null ? '/' : `/?space=${encodeURIComponent(slug)}`;

  const navItem = (href: string, label: string, icon: IconName) => (
    <li key={href}>
      <Link href={href} aria-current={current === href ? 'page' : undefined}>
        <Icon name={icon} />
        <span className="label">{label}</span>
      </Link>
    </li>
  );

  const spaceItem = (
    { space, open, waiting }: SidebarSpace, icon: IconName
  ) => {
    /*
     * Open plus waiting: everything still on your plate in that Space. Open
     * alone read as "nothing here" for a Space whose only task was blocked,
     * and it disagreed with My tasks, which now lists both.
     */
    const live = open + waiting;
    return (
    <li key={space.id}>
      <Link
        href={spaceHref(space.slug)}
        aria-current={activeSlug === space.slug ? 'page' : undefined}
      >
        <Icon name={icon} />
        <span className="label">{shortSpaceName(space)}</span>
        {live > 0 ? <span className="count">{live}</span> : null}
      </Link>
    </li>
    );
  };

  /**
   * A collapsible rail group.
   *
   * `details`/`summary`, the same mechanism the task cards and the settings
   * panels use, because this app ships no client JavaScript. That has one
   * consequence worth knowing: a collapsed group re-opens on the next
   * navigation, since every page is a fresh server render and there is
   * nowhere to keep the state. Open by default, so nothing is ever hidden
   * from someone who has not touched it.
   */
  const railGroup = (label: string, body: React.ReactNode) => (
    <details className="rail-group" open>
      <summary>
        <span className="chevron" aria-hidden="true" />
        {label}
      </summary>
      {body}
    </details>
  );

  const clients = spaces.filter((s) => isClientSpace(s.space));
  const internal = spaces.filter((s) => !isClientSpace(s.space));
  const total = spaces.reduce((n, s) => n + s.open + s.waiting, 0);

  return (
    <nav className="rail" aria-label="Navigation">
      <Link className="workspace" href="/">
        <Image src="/tasks-logo.png" alt="" width={30} height={30} priority />
        {/*
          The signed-in name used to sit under the workspace name. With no
          production sign-in it only ever read "Local development user", which
          is chrome describing the environment rather than anything about the
          work. requireUser() still gates every page; only the label is gone.
        */}
        <span className="names">
          <span className="team">Team Riley</span>
        </span>
      </Link>

      {/*
        These four are the reports: the cross-Space views, as against the
        Spaces below them, which each scope to one. They were an unlabelled
        list at the top of the rail; naming the group is what lets it collapse
        like the other two.
      */}
      {railGroup('Reports', (
        <ul className="group">
          {navItem('/', 'My tasks', 'inbox')}
          {navItem('/today', 'Due today', 'calendar')}
          {navItem('/waiting', 'Waiting', 'paused')}
          {navItem('/history', 'Completed', 'done')}
        </ul>
      ))}

      {railGroup('Spaces', (
        <ul className="group space-list">
          <li>
            {/* Current only on My tasks itself: it links there, so lighting it
                up on Waiting or Completed claimed a view you were not on. */}
            <Link
              href={spaceHref(null)}
              aria-current={current === '/' && activeSlug === null ? 'page' : undefined}
            >
              <Icon name="space" />
              <span className="label">All spaces</span>
              {total > 0 ? <span className="count">{total}</span> : null}
            </Link>
          </li>
          {internal.map((s) => spaceItem(s, 'space'))}
        </ul>
      ))}

      {clients.length > 0 ? railGroup('Clients', (
        <ul className="group space-list">
          {clients.map((s) => spaceItem(s, 'client'))}
        </ul>
      )) : null}

      <span className="grow" />
      <ul className="group foot">
        {navItem('/spaces', 'Spaces', 'space')}
        {navItem('/settings', 'Settings', 'cog')}
      </ul>
    </nav>
  );
}
