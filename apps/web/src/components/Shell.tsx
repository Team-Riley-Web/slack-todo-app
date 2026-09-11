import { Sidebar, type SidebarSpace } from './Sidebar';
import { SearchBox } from './SearchBox';

/**
 * Chrome shared by every signed-in page.
 *
 * The header is one row: heading on the left, search on the right. The
 * subtitle is optional and mostly unused now — a count of tasks above a list
 * of the same tasks was noise.
 */
export function Shell(props: {
  current: string;
  spaces: SidebarSpace[];
  activeSlug?: string | null;
  title: string;
  subtitle?: string;
  /** Where the search form submits, and the filters it must carry through. */
  searchPath?: string;
  searchParams?: Record<string, string | string[] | undefined>;
  /** Filters, under the header. */
  toolbar?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="app">
      <Sidebar
        spaces={props.spaces}
        activeSlug={props.activeSlug ?? null}
        current={props.current}
      />
      <main className="main">
        <header className="page-head">
          <div className="heading">
            <h1>{props.title}</h1>
            {props.subtitle ? <p className="sub">{props.subtitle}</p> : null}
          </div>
          {props.searchPath ? (
            <SearchBox path={props.searchPath} params={props.searchParams ?? {}} />
          ) : null}
        </header>
        {props.toolbar ? <div className="toolbar">{props.toolbar}</div> : null}
        <div className="content">{props.children}</div>
      </main>
    </div>
  );
}
