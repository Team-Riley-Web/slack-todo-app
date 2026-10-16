import { listSpaces } from '@tr/task-core';
import { getDb } from '@/db';
import { requireUser } from '@/user';
import { parseFilters } from '@/data/filters';
import { myTasks, knownAssignees, spaceSummary } from '@/data/tasks';
import { Shell } from '@/components/Shell';
import { FilterBar } from '@/components/FilterBar';
import { TaskList } from '@/components/TaskRow';
import { EditPane } from '@/components/EditPane';
import { SectionCard } from '@/components/SectionCard';
import { assigneeLabels } from '@/lib/env';
import { sortRows } from '@/lib/sort';
import { spaceBySlug, shortSpaceName } from '@/lib/display';

/**
 * Every open task with a priority, P0 first, then P1, P2, P3 -- and within a
 * level, soonest due first.
 *
 * What is already in Today is left out: Today is worked first, so repeating
 * those tasks here would make you read them twice. Today means the same thing
 * it does on My Tasks -- due today or earlier and not done -- through the same
 * query, so the two views can never disagree about which tasks belong to it.
 */
export default async function PrioritiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Called for the gate, not for a value: it redirects when not signed in.
  await requireUser();
  const query = await searchParams;
  const chosen = parseFilters(query);
  // `status` is pinned by the view, not chosen, so the filter bar is given
  // only what the URL asked for -- otherwise it offers to Clear a filter
  // nobody set.
  const filters = { ...chosen, status: 'open' as const };
  const editing = Array.isArray(query.edit) ? query.edit[0] : query.edit;
  const db = await getDb();

  const [open, today, spaces, assignees, summary] = await Promise.all([
    myTasks(db, filters),
    myTasks(db, { ...filters, due: 'today' }),
    listSpaces(db),
    knownAssignees(db),
    spaceSummary(db),
  ]);

  const inToday = new Set(today.map((r) => r.task.id));
  const labels = assigneeLabels();
  // Priority first, then due date: sortRows is stable, so sorting by due and
  // then by priority leaves each level in due order.
  const rows = sortRows(
    sortRows(
      open.filter((r) => r.task.priority && !inToday.has(r.task.id)),
      { sort: 'due' },
      labels
    ),
    { sort: 'priority' },
    labels
  );

  const only = spaceBySlug(spaces, filters.space);

  return (
    <Shell
      path="/priorities"
      current="/priorities"
      spaces={summary.map(({ space, open, waiting }) => ({ space, open, waiting }))}
      activeSlug={filters.space ?? null}
      searchPath="/priorities"
      searchParams={query}
      title={only ? shortSpaceName(only) : 'Priorities'}
      toolbar={
        <FilterBar
          path="/priorities"
          filters={chosen}
          assignees={assignees}
          assigneeLabels={labels}
          show={['assignee']}
        />
      }
    >
      {/* No sort links: this view's order IS the point of it. */}
      <SectionCard label="Priorities" count={rows.length} showSpace={!only}>
        <TaskList
          rows={rows}
          showSpace={!only}
          empty="No prioritised tasks outside Today."
          assigneeLabels={labels}
          basePath="/priorities"
          params={query}
        />
      </SectionCard>

      {editing ? (
        <EditPane
          db={db}
          taskId={editing}
          basePath="/priorities"
          params={query}
          assigneeLabels={labels}
        />
      ) : null}
    </Shell>
  );
}
