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
import { sortRows, sortingFor } from '@/lib/sort';
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
  // Called for the gate, not for a value: it redirects when not signed in.
  await requireUser();
  const { slug } = await params;
  const db = await getDb();

  const spaces = await listSpaces(db);
  const space = spaces.find((s) => s.slug === slug);
  if (!space) notFound();

  const query = await searchParams;
  // The URL slug wins over any space filter in the query string.
  const base = { ...parseFilters(query), space: slug };
  // Ordering comes from the URL's own params, never a page's derived
  // filters, so a header link reproduces exactly the view it sits on.
  const sortBy = parseFilters(query);
  const sorting = sortingFor(`/spaces/${slug}`, sortBy);
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
    startOpen: boolean,
    /* The Waiting section holds blocked tasks, so it wants the same two
       columns the /waiting page shows. Without this it would be the one place
       a task's blocker is invisible. */
    showWaiting = false
  ) => (
    <SectionCard sorting={sorting}
      key={label}
      label={label}
      count={rows.length}
      startOpen={startOpen}
      createHref={`/spaces/${space.slug}`}
      showSpace={false}
      showWaiting={showWaiting}
    >
      {/* The heading names the Space; the rows do not repeat it. */}
      <TaskList
        rows={sortRows(rows, sortBy, assigneeLabels())}
        empty={empty}
        showSpace={false}
        showWaiting={showWaiting}
        basePath={`/spaces/${space.slug}`}
        params={query}
        assigneeLabels={assigneeLabels()}
      />
    </SectionCard>
  );

  return (
    <Shell
      current="/"
      spaces={summary.map(({ space: s, open: o, waiting: w }) => ({
        space: s, open: o, waiting: w,
      }))}
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
      {section('Waiting', waiting, 'Nothing waiting.', true, true)}
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
