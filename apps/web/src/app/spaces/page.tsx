import Link from 'next/link';
import { getDb } from '@/db';
import { requireUser } from '@/user';
import { spaceSummary } from '@/data/tasks';
import { Shell } from '@/components/Shell';
import { spaceHref, shortSpaceName } from '@/lib/display';

export default async function SpacesPage() {
  const user = await requireUser();
  const rows = await spaceSummary(await getDb());

  return (
    <Shell current="/spaces" who={user.name ?? user.slackUserId}>
      <h1>Spaces</h1>
      <p className="muted small">
        Every Space, including the empty ones. Counts exclude nothing.
      </p>
      <div className="spaces">
        {rows.map(({ space, open, waiting, completed }) => (
          <div className="space-card" key={space.id}>
            <h3>
              <Link href={spaceHref(space)}>{shortSpaceName(space)}</Link>
            </h3>
            <div className="counts">
              <span className="open">{open} open</span>
              <span>{waiting} waiting</span>
              <span>{completed} done</span>
            </div>
          </div>
        ))}
      </div>
    </Shell>
  );
}
