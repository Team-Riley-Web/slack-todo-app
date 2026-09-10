import { notFound } from 'next/navigation';
import { listSpaces } from '@tr/task-core';
import { getDb } from '@/db';
import { requireUser } from '@/user';
import { parseFilters } from '@/data/filters';
import { myTasks, spaceSummary } from '@/data/tasks';
import { Shell } from '@/components/Shell';
import { FilterBar } from '@/components/FilterBar';
import { TaskList } from '@/components/TaskRow';
import { NewTaskForm } from '@/components/NewTaskForm';
import { assigneeLabels } from '@/lib/env';
import { shortSpaceName } from '@/lib/display';

export default async function SpacePage({
  params, searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const { slug } = await params;
  const db = await getDb();

  const spaces = await listSpaces(db);
  const space = spaces.find((s) => s.slug === slug);
  if (!space) notFound();

  // The URL slug wins over any space filter in the query string.
  const query = await searchParams;
  const filters = { ...parseFilters(query), space: slug };
  const [rows, summary] = await Promise.all([
    myTasks(db, filters),
    spaceSummary(db),
  ]);
  const counts = summary.find((s) => s.space.id === space.id);

  return (
    <Shell current="/spaces" who={user.name ?? user.slackUserId}>
      <h1>{shortSpaceName(space)}</h1>
      <p className="muted small">
        {counts?.open ?? 0} open · {counts?.waiting ?? 0} waiting ·{' '}
        {counts?.completed ?? 0} completed
      </p>
      <NewTaskForm
        spaceSlug={space.slug}
        error={query.error ? String(query.error) : undefined}
      />
      <FilterBar
        path={`/spaces/${space.slug}`}
        filters={filters}
        spaces={spaces}
        show={['status', 'due', 'search']}
      />
      <TaskList
        rows={rows}
        empty="Nothing here yet."
        assigneeLabels={assigneeLabels()}
      />
    </Shell>
  );
}
