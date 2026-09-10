import { listSpaces } from '@tr/task-core';
import { getDb } from '@/db';
import { requireUser } from '@/user';
import { parseFilters } from '@/data/filters';
import { history, knownAssignees, spaceSummary } from '@/data/tasks';
import { Shell } from '@/components/Shell';
import { FilterBar } from '@/components/FilterBar';
import { TaskList } from '@/components/TaskRow';
import { EditPane } from '@/components/EditPane';
import { SectionCard } from '@/components/SectionCard';
import { assigneeLabels } from '@/lib/env';

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const query = await searchParams;
  const filters = parseFilters(query);
  const editing = Array.isArray(query.edit) ? query.edit[0] : query.edit;
  const db = await getDb();

  const [rows, spaces, assignees] = await Promise.all([
    history(db, filters),
    listSpaces(db),
    knownAssignees(db),
  ]);

  // The rail comes from the same summary the /spaces page uses, so a count
  // there and a count here can never disagree.
  const railSpaces = (await spaceSummary(db)).map(({ space, open, waiting }) => ({
    space, open, waiting,
  }));

  return (
    <Shell
      current="/history"
      who={user.name ?? user.slackUserId}
      spaces={railSpaces}
      railPath="/history"
      activeSlug={filters.space ?? null}
      searchPath="/history"
      searchParams={query}
      title="Completed"
      subtitle="Nothing is ever deleted; untick one to reopen it."
      toolbar={
        <FilterBar
          path="/history"
          filters={filters}
          assignees={assignees}
          assigneeLabels={assigneeLabels()}
          show={['dates', 'assignee']}
        />
      }
    >
      <SectionCard label="Completed" count={rows.length}>
        <TaskList
          rows={rows}
          empty="Nothing completed in this range."
          showProvenance
          assigneeLabels={assigneeLabels()}
          basePath="/history"
          params={query}
        />
      </SectionCard>

      {editing ? (
        <EditPane
          db={db}
          taskId={editing}
          basePath="/history"
          params={query}
          assigneeLabels={assigneeLabels()}
        />
      ) : null}
    </Shell>
  );
}
