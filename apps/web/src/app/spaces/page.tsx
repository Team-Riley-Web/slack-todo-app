import Link from 'next/link';
import { getDb } from '@/db';
import { requireUser } from '@/user';
import { spaceSummary } from '@/data/tasks';
import { Shell } from '@/components/Shell';
import { spaceHref, shortSpaceName } from '@/lib/display';
import { removeSpaceFormVoid, addSpaceFormVoid } from '@/actions/settings';

export default async function SpacesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const { error } = await searchParams;
  const rows = await spaceSummary(await getDb());

  return (
    <Shell
      current="/spaces"
      who={user.name ?? user.slackUserId}
      spaces={rows.map(({ space, open, waiting }) => ({ space, open, waiting }))}
      railPath="/"
      activeSlug={null}
    >
      <h1>Spaces</h1>
      <p className="muted small">
        Every Space, including the empty ones. Counts exclude nothing.
      </p>

      {error ? <p className="error">{String(error)}</p> : null}

      <form className="filters" action={addSpaceFormVoid}>
        <input
          type="text"
          name="name"
          required
          maxLength={80}
          placeholder="New Space, e.g. Client - Rosario Landscaping"
          aria-label="New Space name"
        />
        <button type="submit" className="primary">Add Space</button>
      </form>
      <p className="muted small">
        Stored exactly as typed. Naming a Space that already exists selects it
        rather than creating a second one.
      </p>

      <div className="spaces">
        {rows.map(({ space, open, waiting, completed }) => {
          const total = open + waiting + completed;
          return (
            <div className="space-card" key={space.id}>
              <h3>
                <Link href={spaceHref(space)}>{shortSpaceName(space)}</Link>
              </h3>
              <div className="counts">
                <span className="open">{open} open</span>
                <span>{waiting} waiting</span>
                <span>{completed} done</span>
              </div>

              {/*
                Delete is offered only where it can actually succeed: never for
                Inbox, and never for a Space still holding tasks. `deleteSpace`
                refuses both regardless, so this is the UI agreeing with the
                rule rather than enforcing it.
              */}
              {space.is_inbox ? (
                <p className="muted small">The fallback Space. Cannot be deleted.</p>
              ) : total > 0 ? (
                <p className="muted small">
                  Holds {total} task{total === 1 ? '' : 's'} — move them to delete this Space.
                </p>
              ) : (
                /*
                  A native `details` disclosure is the confirmation step. This
                  app ships no client JavaScript, so there is no onClick
                  confirm available -- and a bare button would delete on one
                  stray click. Two deliberate clicks, no script.
                */
                <details className="confirm-delete">
                  <summary>Delete</summary>
                  <form action={removeSpaceFormVoid}>
                    <input type="hidden" name="spaceId" value={space.id} />
                    <p className="muted small">
                      Removes the Space, its lists, and any channel mapping or
                      alias pointing at it. Channels mapped here fall back to
                      Inbox.
                    </p>
                    <button type="submit" className="danger">
                      Yes, delete {shortSpaceName(space)}
                    </button>
                  </form>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </Shell>
  );
}
