import Link from 'next/link';
import Image from 'next/image';
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
          {/*
            The mark, phone only. The rail carries it on a desktop, and on a
            phone the rail is a drawer -- so without this the app had nothing
            identifying it on screen until you opened the menu. Decorative:
            the alt is empty because the title beside it already names the view.
          */}
          <Image
            className="head-logo"
            src="/tasks-logo.png"
            alt=""
            width={28}
            height={28}
            priority
          />
          <div className="heading">
            <h1>{props.title}</h1>
            {props.subtitle ? <p className="sub">{props.subtitle}</p> : null}
          </div>
          {/*
            The search toggle, shown only on a phone.
            
            A magnifier in the bar rather than a field taking a whole row of a
            390px screen: search is occasional, and the row it was costing is
            the one the filters now use.
            
            Open state is a checkbox, the same mechanism as the drawer and the
            assignee menu. The field it reveals lives in the toolbar, which is
            not a sibling of this input, so the rule that shows it hangs off
            `body:has(...)` -- the one selector that can read a checkbox from an
            ancestor.
          */}
          {props.searchPath ? (
            <>
              <input
                key={props.path + JSON.stringify(query)}
                type="checkbox"
                id="search-state"
                className="search-state"
                aria-label="Search"
                autoComplete="off"
              />
              <label className="search-button" htmlFor="search-state">
                <Icon name="search" />
                <span className="sr-only">Search tasks</span>
              </label>
            </>
          ) : null}
        </header>
        {/*
          One toolbar row, not two.
          
          Search and New task used to sit on the title line, with the filters
          on a line of their own beneath -- two rows of chrome above every
          list. They are all controls for the same list, so they belong
          together.
          
          Reading order left to right is: what narrows the list (due pills,
          then assignee, then search), and last the one thing that ADDS to it.
          The pills stay left because they are the control you reach for most;
          the action sits furthest from them so it is never hit by accident.
        */}
        <div className="toolbar">
          {props.toolbar}
          <div className="page-actions">
            {props.searchPath ? (
              <SearchBox path={props.searchPath} params={query} />
            ) : null}
            <Link className="btn primary" href={newTaskHref(props.path, query)}>
              <Icon name="plus" />
              {/* The words drop on a phone so the whole filter row fits one
                  line; the plus and the accessible name carry it there. */}
              <span className="btn-label">New task</span>
              <span className="sr-only">New task</span>
            </Link>
          </div>
        </div>
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
