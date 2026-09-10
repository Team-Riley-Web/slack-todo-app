import { notFound } from 'next/navigation';
import { listSpaces } from '@tr/task-core';
import { getDb } from '@/db';
import { requireUser } from '@/user';
import { parseFilters } from '@/data/filters';
import { myTasks, spaceSummary } from '@/data/tasks';
import { Shell } from '@/components/Shell';
import { FilterBar } from '@/components/FilterBar';
import { TaskList } from '@/components/TaskRow';
import { EditPane } from '@/components/EditPane';
import { SectionCard } from '@/components/SectionCard';
import { NewTaskForm } from '@/components/NewTaskForm';
import { assigneeLabels } from '@/lib/env';
import { shortSpaceName } from '@/lib/display';

/**
 * One Space, in three collapsible sections: Open, Waiting, Completed.
 *
 * `details`/`summary` does the collapsing, so it needs no client JavaScript
 * and the browser remembers nothing it should not. Open and Waiting start
 * expanded because they are the work; Completed starts closed because it only
 * grows.
 */
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

  const query = await searchParams;
  // The URL slug wins over any space filter in the query string.
  const base = { ...parseFilters(query), space: slug };
  const editing = Array.isArray(query.edit) ? query.edit[0] : query.edit;

  // Three queries rather than one filtered client-side, so each section counts
  // and shows exactly what it says.
  const [open, waiting, completed, summary] = await Promise.all([
    myTasks(db, { ...base, status: 'open' }),
    myTasks(db, { ...base, status: 'waiting' }),
    myTasks(db, { ...base, status: 'completed' }),
    spaceSummary(db),
  ]);
  const counts = summary.find((s) => s.space.id === space.id);

  const section = (
    label: string,
    rows: typeof open,
    empty: string,
    startOpen: boolean
  ) => (
    <SectionCard
      key={label}
      label={label}
      count={rows.length}
      startOpen={startOpen}
      createHref={`/spaces/${space.slug}`}
      showSpace={false}
    >
      {/* The heading names the Space; the rows do not repeat it. */}
      <TaskList
        rows={rows}
        empty={empty}
        showSpace={false}
        basePath={`/spaces/${space.slug}`}
        params={query}
        assigneeLabels={assigneeLabels()}
      />
    </SectionCard>
  );

  return (
    <Shell
      current="/"
      who={user.name ?? user.slackUserId}
      spaces={summary.map(({ space: s, open: o, waiting: w }) => ({
        space: s, open: o, waiting: w,
      }))}
      railPath="/"
      activeSlug={space.slug}
      searchPath={`/spaces/${space.slug}`}
      searchParams={query}
      title={shortSpaceName(space)}
      subtitle={
        `${counts?.open ?? 0} open · ${counts?.waiting ?? 0} waiting · ` +
        `${counts?.completed ?? 0} completed`
      }
      toolbar={
        <>
          <NewTaskForm
            spaceSlug={space.slug}
            error={query.error ? String(query.error) : undefined}
          />
          {/* No status chips: the sections below ARE the status split. */}
          <FilterBar
            path={`/spaces/${space.slug}`}
            filters={base}
            show={['due']}
          />
        </>
      }
    >

      {section('Open', open, 'Nothing open.', true)}
      {section('Waiting', waiting, 'Nothing waiting.', true)}
      {section('Completed', completed, 'Nothing completed yet.', false)}

      {editing ? (
        <EditPane
          db={db}
          taskId={editing}
          basePath={`/spaces/${space.slug}`}
          params={query}
          assigneeLabels={assigneeLabels()}
        />
      ) : null}
    </Shell>
  );
}
