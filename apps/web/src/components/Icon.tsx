/**
 * The handful of icons the sidebar needs, inline.
 *
 * Inline SVG rather than an icon font or a package: eleven glyphs are not worth
 * a dependency, and inline means they inherit `currentColor` so the active
 * and hover states need no extra rules.
 *
 * Every glyph has to survive 16px, which is the only size the rail uses.
 * Detail that reads at 34px and closes up at 16 is worse than no detail.
 *
 * 16px on a 24-unit grid, 1.6 stroke — thin enough to sit beside 14px text
 * without shouting.
 */
export type IconName =
  | 'inbox' | 'calendar' | 'paused' | 'done' | 'space' | 'client' | 'cog'
  | 'search' | 'pencil' | 'trash' | 'plus' | 'menu' | 'close';

const PATHS: Record<IconName, string> = {
  /*
   * My tasks: an inbox tray.
   *
   * It was a ticked box, which said the same thing as Completed's checkmark
   * one row below -- the two most-used items in the rail read alike. A tray
   * says "everything of mine, unsorted" and shares no shape with any other
   * glyph in the set. A circled check and a checklist were tried: the first
   * still reads as Completed, and the second turns to mush at 16px.
   */
  inbox: 'M3.5 14h4.4l1.3 2h5.6l1.3-2h4.4M6.3 5.5h11.4a1 1 0 01.95.69L21 14v3.5a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 17.5V14l2.35-7.81a1 1 0 01.95-.69z',
  // Due today
  calendar: 'M4.5 8.5h15M7.5 4.5v3M16.5 4.5v3M5.5 6.5h13a1 1 0 011 1v11a1 1 0 01-1 1h-13a1 1 0 01-1-1v-11a1 1 0 011-1z',
  /*
   * Waiting: the pause bars, now inside a circle.
   *
   * Bare bars read as two stray marks rather than an icon. Enclosing them
   * makes it a control, and keeps the meaning the old glyph had -- stopped,
   * not moving -- which is what "Waiting / blocked" is. A clock was the other
   * candidate and lost on purpose: Due today is already a calendar, and a
   * second time-shaped glyph beside it would say "date" rather than "stuck".
   */
  paused: 'M12 20.5a8.5 8.5 0 100-17 8.5 8.5 0 000 17zM10.2 9.3v5.4M13.8 9.3v5.4',
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
  plus: 'M12 5v14M5 12h14',
  /*
   * The hamburger. Three bars on the same 24 grid and the same 1.6 stroke as
   * every other glyph here, at the spacing `space` already uses -- it is the
   * one shape everyone reads as "the navigation", and inventing a different
   * one would make it harder to recognise, not more original.
   */
  menu: 'M4.5 6.5h15M4.5 12h15M4.5 17.5h15',
  /* The X that replaces the hamburger while the drawer is open. Same 24 grid
     and stroke; it is the same control in its other state, not a new one. */
  close: 'M6 6l12 12M18 6L6 18',
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
