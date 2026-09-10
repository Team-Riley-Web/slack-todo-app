import Link from 'next/link';
import { getDb } from '@/db';
import { requireUser } from '@/user';
import { spaceSummary } from '@/data/tasks';
import { Shell } from '@/components/Shell';
import { SectionCard } from '@/components/SectionCard';
import { spaceHref, shortSpaceName } from '@/lib/display';
import { removeSpaceFormVoid, addSpaceFormVoid } from '@/actions/settings';

/**
 * Every Space, as a list rather than a grid of cards.
 *
 * Cards made twelve Spaces look like twelve things to read. The same row
 * shape the task lists use scans in one pass, and the counts sit in columns
 * instead of wrapping under each name.
 *
 * Adding a Space is a pane opened with `?new=1`, for the same reason editing
 * is: the list stays visible behind it, and the form is not sitting in the
 * page permanently taking up room.
 */
export default async function SpacesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const query = await searchParams;
  const error = Array.isArray(query.error) ? query.error[0] : query.error;
  const adding = query.new !== undefined;
  const rows = await spaceSummary(await getDb());

  return (
    <Shell
      current="/spaces"
      who={user.name ?? user.slackUserId}
      spaces={rows.map(({ space, open, waiting }) => ({ space, open, waiting }))}
      railPath="/"
      activeSlug={null}
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
          {rows.map(({ space, open, waiting, completed }) => {
            const total = open + waiting + completed;
            return (
              <li className="row spacerow" key={space.id}>
                <span className="title">
                  <Link href={spaceHref(space)}>{shortSpaceName(space)}</Link>
                </span>
                <span className="num">{open}</span>
                <span className="num">{waiting}</span>
                <span className="num">{completed}</span>
                <span className="rowactions">
                  {/*
                    Delete is offered only where it can succeed: never Inbox,
                    never a Space holding tasks. deleteSpace refuses both
                    regardless, so this is the UI agreeing with the rule
                    rather than enforcing it.
                  */}
                  {space.is_inbox ? (
                    <span className="muted small">Fallback</span>
                  ) : total > 0 ? (
                    <span className="muted small">{total} to move</span>
                  ) : (
                    /*
                      A native details disclosure is the confirmation step:
                      this app ships no client JavaScript, so a bare button
                      would delete on one stray click.
                    */
                    <details className="confirm-delete">
                      <summary>Delete</summary>
                      <form action={removeSpaceFormVoid}>
                        <input type="hidden" name="spaceId" value={space.id} />
                        <p className="muted small">
                          Removes the Space, its lists, and any channel mapping
                          or alias pointing at it. Channels mapped here fall
                          back to Inbox.
                        </p>
                        <button type="submit" className="danger">
                          Yes, delete {shortSpaceName(space)}
                        </button>
                      </form>
                    </details>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </SectionCard>

      {adding ? (
        <>
          <Link className="pane-backdrop" href="/spaces" aria-label="Close" />
          <aside className="pane" aria-label="Add a Space">
            <header className="pane-head">
              <h2>Add a Space</h2>
              <Link className="pane-close" href="/spaces" aria-label="Close">×</Link>
            </header>
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
                Stored exactly as typed. Prefix with <code>Client - </code> to
                file it under Clients in the sidebar. Naming a Space that
                already exists selects it rather than creating a second one.
              </p>
              <div className="filters">
                <button type="submit" className="primary">Add Space</button>
                <Link className="btn" href="/spaces">Cancel</Link>
              </div>
            </form>
          </aside>
        </>
      ) : null}
    </Shell>
  );
}
