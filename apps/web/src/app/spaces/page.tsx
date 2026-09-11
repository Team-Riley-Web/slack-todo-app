import Link from 'next/link';
import { PaneShell } from '@/components/PaneShell';
import { getDb } from '@/db';
import { requireUser } from '@/user';
import { spaceSummary } from '@/data/tasks';
import { Shell } from '@/components/Shell';
import { SectionCard } from '@/components/SectionCard';
import { Icon } from '@/components/Icon';
import { spaceHref, shortSpaceName } from '@/lib/display';
import {
  removeSpaceFormVoid, addSpaceFormVoid, editSpaceFormVoid,
} from '@/actions/settings';

/**
 * Every Space, as a list with an actions column.
 *
 * The actions column is two icons, not prose. It used to read "Fallback",
 * "7 to move", or a Delete disclosure depending on the row, which meant three
 * different things in one column and a paragraph of explanation on the far
 * right of a list you were trying to scan.
 *
 * Both icons open a pane, the same mechanism the task editor uses, so the list
 * stays visible behind them and each one has a linkable URL. Whether a Space
 * can actually be deleted is decided in the pane, where there is room to say
 * why — `deleteSpace` refuses Inbox and refuses a Space holding tasks
 * regardless of what this page renders.
 */
export default async function SpacesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Called for the gate, not for a value: it redirects when not signed in.
  await requireUser();
  const query = await searchParams;
  const one = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;

  const error = one(query.error);
  const adding = query.new !== undefined;
  const editingId = one(query.edit);
  const deletingId = one(query.delete);

  const rows = await spaceSummary(await getDb());
  const editing = rows.find((r) => r.space.id === editingId);
  const deleting = rows.find((r) => r.space.id === deletingId);

  return (
    <Shell
      path="/spaces"
      current="/spaces"
      spaces={rows.map(({ space, open, waiting }) => ({ space, open, waiting }))}
      activeSlug={null}
      searchParams={query}
      title="Spaces"
      toolbar={
        <div className="filters">
          <Link className="btn primary" href="/spaces?new=1">Add Space</Link>
        </div>
      }
    >
      {error ? <p className="error">{String(error)}</p> : null}

      <SectionCard label="All spaces" count={rows.length} columns="spaces">
        <ul className="rows">
          {rows.map(({ space, open, waiting, completed }) => (
            <li className="row spacerow" key={space.id}>
              <span className="title">
                <Link href={spaceHref(space)}>{shortSpaceName(space)}</Link>
              </span>
              <span className="num">{open}</span>
              <span className="num">{waiting}</span>
              <span className="num">{completed}</span>
              <span className="iconactions">
                <Link
                  className="iconbtn"
                  href={`/spaces?edit=${encodeURIComponent(space.id)}`}
                  title={`Rename ${shortSpaceName(space)}`}
                  aria-label={`Rename ${shortSpaceName(space)}`}
                >
                  <Icon name="pencil" />
                </Link>
                {/* Inbox has no delete: every unmapped capture falls back to it. */}
                {space.is_inbox ? null : (
                  <Link
                    className="iconbtn danger"
                    href={`/spaces?delete=${encodeURIComponent(space.id)}`}
                    title={`Delete ${shortSpaceName(space)}`}
                    aria-label={`Delete ${shortSpaceName(space)}`}
                  >
                    <Icon name="trash" />
                  </Link>
                )}
              </span>
            </li>
          ))}
        </ul>
      </SectionCard>

      {adding ? (
        <SpacePane title="Add a Space" close="/spaces">
          <form className="stack" action={addSpaceFormVoid}>
            <label>
              Name
              <input
                type="text" name="name" required maxLength={80}
                placeholder="e.g. Client - Rosario Landscaping"
                aria-label="New Space name"
              />
            </label>
            <p className="muted small">
              Stored exactly as typed. Prefix with <code>Client - </code> to file
              it under Clients in the sidebar.
            </p>
            <PaneButtons label="Add Space" />
          </form>
        </SpacePane>
      ) : null}

      {editing ? (
        <SpacePane title="Rename Space" close="/spaces">
          <form className="stack" action={editSpaceFormVoid}>
            <input type="hidden" name="spaceId" value={editing.space.id} />
            <label>
              Name
              <input
                type="text" name="name" required maxLength={80}
                defaultValue={editing.space.name}
                aria-label="Space name"
              />
            </label>
            <p className="muted small">
              The old name keeps working: it is recorded as an alias, so{' '}
              <code>/tasks {editing.space.slug}</code> and any channel map or
              import config naming the old Space still resolve. The URL slug is
              regenerated from the new name.
            </p>
            <PaneButtons label="Save" />
          </form>
        </SpacePane>
      ) : null}

      {deleting ? (
        <SpacePane title={`Delete ${shortSpaceName(deleting.space)}?`} close="/spaces">
          {deleting.open + deleting.waiting + deleting.completed > 0 ? (
            <>
              <p>
                This Space holds{' '}
                <strong>
                  {deleting.open + deleting.waiting + deleting.completed} tasks
                </strong>
                , completed ones included. Those are history, so it cannot be
                deleted until they are moved.
              </p>
              <div className="filters">
                <Link className="btn primary" href={spaceHref(deleting.space)}>
                  Open {shortSpaceName(deleting.space)}
                </Link>
                <Link className="btn" href="/spaces" data-pane-close>Cancel</Link>
              </div>
            </>
          ) : (
            <form className="stack" action={removeSpaceFormVoid}>
              <input type="hidden" name="spaceId" value={deleting.space.id} />
              <p>
                Removes the Space, its lists, and any channel mapping or alias
                pointing at it. Channels mapped here fall back to Inbox.
              </p>
              <div className="filters">
                <button type="submit" className="danger">
                  Yes, delete {shortSpaceName(deleting.space)}
                </button>
                <Link className="btn" href="/spaces" data-pane-close>Cancel</Link>
              </div>
            </form>
          )}
        </SpacePane>
      ) : null}
    </Shell>
  );
}

/** The pane chrome, shared by add, rename and delete. */
function SpacePane({
  title, close, children,
}: {
  title: string;
  close: string;
  children: React.ReactNode;
}) {
  return (
    /* PaneShell plays the exit animation before the pane goes away. */
    <PaneShell>
      {/* The backdrop is a link, so clicking away closes the pane. */}
      <Link className="pane-backdrop" href={close} aria-label="Close" data-pane-close />
      <aside className="pane" aria-label={title}>
        <header className="pane-head">
          <h2>{title}</h2>
          <Link className="pane-close" href={close} aria-label="Close" data-pane-close>×</Link>
        </header>
        {children}
      </aside>
    </PaneShell>
  );
}

function PaneButtons({ label }: { label: string }) {
  return (
    <div className="filters">
      <button type="submit" className="primary">{label}</button>
      <Link className="btn" href="/spaces" data-pane-close>Cancel</Link>
    </div>
  );
}
