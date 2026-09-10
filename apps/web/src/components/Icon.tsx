/**
 * The handful of icons the sidebar needs, inline.
 *
 * Inline SVG rather than an icon font or a package: five glyphs is not worth
 * a dependency, and inline means they inherit `currentColor` so the active
 * and hover states need no extra rules.
 *
 * 16px on a 24-unit grid, 1.6 stroke — thin enough to sit beside 14px text
 * without shouting.
 */
export type IconName =
  | 'check' | 'calendar' | 'pause' | 'done' | 'space' | 'client' | 'cog'
  | 'search' | 'pencil' | 'trash';

const PATHS: Record<IconName, string> = {
  // My tasks: a ticked box
  check: 'M9 11.5l2.2 2.2L15.5 9.4M5.5 4.5h13a1 1 0 011 1v13a1 1 0 01-1 1h-13a1 1 0 01-1-1v-13a1 1 0 011-1z',
  // Due today
  calendar: 'M4.5 8.5h15M7.5 4.5v3M16.5 4.5v3M5.5 6.5h13a1 1 0 011 1v11a1 1 0 01-1 1h-13a1 1 0 01-1-1v-11a1 1 0 011-1z',
  // Waiting
  pause: 'M9.5 6v12M14.5 6v12',
  // Completed
  done: 'M20 6.5L9.5 17 4.5 12',
  // A Space
  space: 'M4.5 6.5h15M4.5 12h15M4.5 17.5h15',
  // A client Space
  client: 'M12 12.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM5 19.5a7 7 0 0114 0',
  cog: 'M12 15a3 3 0 100-6 3 3 0 000 6zM12 3.5v2M12 18.5v2M4.9 7.5l1.7 1M17.4 15.5l1.7 1M4.9 16.5l1.7-1M17.4 8.5l1.7-1',
  search: 'M10.5 17a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM15.2 15.2L20 20',
  pencil: 'M4.5 19.5h4l10-10a2.1 2.1 0 00-3-3l-10 10v3zM15 6.5l2.5 2.5',
  trash: 'M4.5 7.5h15M9.5 7.5v-2a1 1 0 011-1h3a1 1 0 011 1v2M6.5 7.5l.8 11a1 1 0 001 .9h7.4a1 1 0 001-.9l.8-11M10.5 11v5M13.5 11v5',
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
