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
import { spaceBySlug, shortSpaceName } from '@/lib/display';

/**
 * Due today, across every Space.
 *
 * The `due` bucket is pinned here rather than read from the query string, so
 * the view means one thing. Everything else stays filterable.
 */
export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Called for the gate, not for a value: it redirects when not signed in.
  await requireUser();
  const query = await searchParams;
  const filters = { ...parseFilters(query), due: 'today' as const };
  const editing = Array.isArray(query.edit) ? query.edit[0] : query.edit;
  const db = await getDb();

  const [rows, spaces, assignees, summary] = await Promise.all([
    myTasks(db, filters),
    listSpaces(db),
    knownAssignees(db),
    spaceSummary(db),
  ]);

  /*
   * Filtered to a single Space, that Space names the page and drops out of
   * the rows entirely -- both the column and the sub-line. Standing in
   * "CFC Skincare", printing "CFC Skincare" on every row is not information,
   * which is the same reason a card posted in its own channel does not repeat
   * the Space. The section heading below still says which view this is.
   */
  const only = spaceBySlug(spaces, filters.space);

  return (
    <Shell
      current="/today"
      spaces={summary.map(({ space, open, waiting }) => ({ space, open, waiting }))}
      railPath="/today"
      activeSlug={filters.space ?? null}
      searchPath="/today"
      searchParams={query}
      title={only ? shortSpaceName(only) : "Due today"}
      toolbar={
        <FilterBar
          path="/today"
          filters={filters}
          assignees={assignees}
          assigneeLabels={assigneeLabels()}
          show={['assignee']}
        />
      }
    >
      <SectionCard label="Due today" count={rows.length} showSpace={!only}>
        <TaskList
          rows={rows}
          showSpace={!only}
          empty="Nothing due today."
          assigneeLabels={assigneeLabels()}
          basePath="/today"
          params={query}
        />
      </SectionCard>

      {editing ? (
        <EditPane
          db={db}
          taskId={editing}
          basePath="/today"
          params={query}
          assigneeLabels={assigneeLabels()}
        />
      ) : null}
    </Shell>
  );
}
