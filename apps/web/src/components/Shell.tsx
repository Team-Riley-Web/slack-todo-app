import { Nav } from './Nav';
import { Sidebar, type SidebarSpace } from './Sidebar';

/**
 * Chrome shared by every signed-in page.
 *
 * With `spaces` supplied the page gets the Spaces rail beside its content;
 * without it the content runs full width, which is right for Settings and the
 * edit form where a Space filter means nothing.
 */
export function Shell(props: {
  current: string;
  who: string | null;
  spaces?: SidebarSpace[];
  activeSlug?: string | null;
  /** Which view the rail should filter. Defaults to the current page. */
  railPath?: string;
  children: React.ReactNode;
}) {
  const rail = props.spaces && props.spaces.length > 0;
  return (
    <>
      <Nav current={props.current} who={props.who} />
      {rail ? (
        <div className="with-rail">
          <Sidebar
            spaces={props.spaces!}
            activeSlug={props.activeSlug ?? null}
            path={props.railPath ?? props.current}
          />
          <main className="shell">{props.children}</main>
        </div>
      ) : (
        <main className="shell">{props.children}</main>
      )}
    </>
  );
}
