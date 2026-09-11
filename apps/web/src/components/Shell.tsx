import Link from 'next/link';
import { Sidebar, type SidebarSpace } from './Sidebar';
import { SearchBox } from './SearchBox';
import { NewTaskPane } from './NewTaskPane';
import { Icon } from './Icon';
import { newTaskHref, newTaskSpace } from '@/lib/display';
import { assigneeLabels, defaultAssigneeId } from '@/lib/env';

/**
 * Chrome shared by every signed-in page.
 *
 * The header is one row: heading on the left, search on the right. The
 * subtitle is optional and mostly unused now — a count of tasks above a list
 * of the same tasks was noise.
 */
export function Shell(props: {
  /** This view's route, used to keep its query state behind a task pane. */
  path: string;
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
  const query = props.searchParams ?? {};
  const creating = query.newTask !== undefined;
  const spaces = props.spaces.map(({ space }) => space);
  const selectedSpace = newTaskSpace(spaces, props.activeSlug);

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
          <div className="page-actions">
            {props.searchPath ? (
              <SearchBox path={props.searchPath} params={query} />
            ) : null}
            <Link className="btn primary" href={newTaskHref(props.path, query)}>
              <Icon name="plus" />
              New task
            </Link>
          </div>
        </header>
        {props.toolbar ? <div className="toolbar">{props.toolbar}</div> : null}
        <div className="content">{props.children}</div>
        {creating ? (
          <NewTaskPane
            spaces={spaces}
            defaultSpaceSlug={selectedSpace?.slug}
            basePath={props.path}
            params={query}
            assigneeLabels={assigneeLabels()}
            defaultAssigneeId={defaultAssigneeId()}
          />
        ) : null}
      </main>
    </div>
  );
}
