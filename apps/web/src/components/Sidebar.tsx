import Link from 'next/link';
import type { Space } from '@tr/task-core';
import { shortSpaceName } from '@/lib/display';

export interface SidebarSpace {
  space: Space;
  open: number;
  waiting: number;
}

/**
 * The Spaces rail.
 *
 * Every Space is one click away, the way a task manager's left rail works,
 * rather than a row of filter chips that has to be re-read each time. The
 * order comes from `listSpaces` -- Inbox first, then alphabetical by the name
 * as displayed -- so it is not re-sorted here and cannot drift from the rest
 * of the app.
 *
 * A count is shown only when there is something to count. A column of zeroes
 * is the noise this is meant to replace.
 */
export function Sidebar({
  spaces, activeSlug, path,
}: {
  spaces: SidebarSpace[];
  /** The Space currently filtered to, or null for all of them. */
  activeSlug: string | null;
  /** Which view the links should filter, so the rail works on any page. */
  path: string;
}) {
  const href = (slug: string | null) =>
    slug === null ? path : `${path}?space=${encodeURIComponent(slug)}`;

  const row = (
    key: string, label: string, slug: string | null, count: number | null
  ) => (
    <li key={key}>
      <Link
        href={href(slug)}
        aria-current={activeSlug === slug ? 'page' : undefined}
      >
        <span className="label">{label}</span>
        {count !== null && count > 0 ? (
          <span className="count">{count}</span>
        ) : null}
      </Link>
    </li>
  );

  const total = spaces.reduce((n, s) => n + s.open, 0);

  return (
    <nav className="rail" aria-label="Spaces">
      <ul>
        {row('__all__', 'All spaces', null, total)}
        {spaces.map((s) =>
          row(s.space.id, shortSpaceName(s.space), s.space.slug, s.open)
        )}
      </ul>
    </nav>
  );
}
