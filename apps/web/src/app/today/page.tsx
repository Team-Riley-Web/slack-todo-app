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
  const user = await requireUser();
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

  return (
    <Shell
      current="/today"
      who={user.name ?? user.slackUserId}
      spaces={summary.map(({ space, open, waiting }) => ({ space, open, waiting }))}
      railPath="/today"
      activeSlug={filters.space ?? null}
      searchPath="/today"
      searchParams={query}
      title="Due today"
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
      <SectionCard label="Due today" count={rows.length}>
        <TaskList
          rows={rows}
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
