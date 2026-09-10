import { Sidebar, type SidebarSpace } from './Sidebar';

/**
 * Chrome shared by every signed-in page: a sidebar carrying all navigation,
 * and a main column carrying nothing but content.
 *
 * `title` and `subtitle` render the page header the way the reference does —
 * a heading with a line of explanation under it — so every page gets the same
 * shape rather than each one inventing its own.
 */
export function Shell(props: {
  current: string;
  who: string | null;
  spaces: SidebarSpace[];
  activeSlug?: string | null;
  /** Which view the Space links filter. Defaults to the current page. */
  railPath?: string;
  title: string;
  subtitle?: string;
  /** The view-tab row or filters, directly under the header. */
  toolbar?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="app">
      <Sidebar
        spaces={props.spaces}
        activeSlug={props.activeSlug ?? null}
        current={props.current}
        path={props.railPath ?? props.current}
        who={props.who}
      />
      <main className="main">
        <header className="page-head">
          <h1>{props.title}</h1>
          {props.subtitle ? <p className="sub">{props.subtitle}</p> : null}
        </header>
        {props.toolbar ? <div className="toolbar">{props.toolbar}</div> : null}
        <div className="content">{props.children}</div>
      </main>
    </div>
  );
}
