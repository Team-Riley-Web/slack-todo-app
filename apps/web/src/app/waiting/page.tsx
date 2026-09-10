import { listSpaces } from '@tr/task-core';
import { getDb } from '@/db';
import { requireUser } from '@/user';
import { parseFilters } from '@/data/filters';
import { waitingTasks, spaceSummary } from '@/data/tasks';
import { Shell } from '@/components/Shell';
import { FilterBar } from '@/components/FilterBar';
import { TaskList } from '@/components/TaskRow';
import { EditPane } from '@/components/EditPane';
import { SectionCard } from '@/components/SectionCard';
import { assigneeLabels } from '@/lib/env';

export default async function WaitingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const query = await searchParams;
  const filters = parseFilters(query);
  const editing = Array.isArray(query.edit) ? query.edit[0] : query.edit;
  const db = await getDb();

  const [rows, spaces] = await Promise.all([
    waitingTasks(db, filters),
    listSpaces(db),
  ]);

  // The rail comes from the same summary the /spaces page uses, so a count
  // there and a count here can never disagree.
  const railSpaces = (await spaceSummary(db)).map(({ space, open, waiting }) => ({
    space, open, waiting,
  }));

  return (
    <Shell
      current="/waiting"
      who={user.name ?? user.slackUserId}
      spaces={railSpaces}
      railPath="/waiting"
      activeSlug={filters.space ?? null}
      searchPath="/waiting"
      searchParams={query}
      title="Waiting / blocked"
      toolbar={
        <FilterBar
          path="/waiting"
          filters={filters}
          show={['assignee']}
        />
      }
    >
      <SectionCard label="Waiting" count={rows.length}>
        <TaskList
          rows={rows}
          empty="Nothing is waiting."
          showAge
          assigneeLabels={assigneeLabels()}
          basePath="/waiting"
          params={query}
        />
      </SectionCard>

      {editing ? (
        <EditPane
          db={db}
          taskId={editing}
          basePath="/waiting"
          params={query}
          assigneeLabels={assigneeLabels()}
        />
      ) : null}
    </Shell>
  );
}
