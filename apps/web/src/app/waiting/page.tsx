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
import { spaceBySlug, shortSpaceName } from '@/lib/display';

export default async function WaitingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Called for the gate, not for a value: it redirects when not signed in.
  await requireUser();
  const query = await searchParams;
  const filters = parseFilters(query);
  const editing = Array.isArray(query.edit) ? query.edit[0] : query.edit;
  const db = await getDb();

  const [rows, spaces] = await Promise.all([
    waitingTasks(db, filters),
    listSpaces(db),
  ]);

  /*
   * Filtered to a single Space, that Space names the page and drops out of
   * the rows entirely -- both the column and the sub-line. Standing in
   * "CFC Skincare", printing "CFC Skincare" on every row is not information,
   * which is the same reason a card posted in its own channel does not repeat
   * the Space. The section heading below still says which view this is.
   */
  const only = spaceBySlug(spaces, filters.space);

  // The rail comes from the same summary the /spaces page uses, so a count
  // there and a count here can never disagree.
  const railSpaces = (await spaceSummary(db)).map(({ space, open, waiting }) => ({
    space, open, waiting,
  }));

  return (
    <Shell
      current="/waiting"
      spaces={railSpaces}
      activeSlug={filters.space ?? null}
      searchPath="/waiting"
      searchParams={query}
      title={only ? shortSpaceName(only) : "Waiting / blocked"}
      toolbar={
        <FilterBar
          path="/waiting"
          filters={filters}
          show={['assignee']}
        />
      }
    >
      <SectionCard
        label="Waiting"
        count={rows.length}
        showSpace={!only}
        showWaiting
      >
        <TaskList
          rows={rows}
          showSpace={!only}
          empty="Nothing is waiting."
          showWaiting
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
