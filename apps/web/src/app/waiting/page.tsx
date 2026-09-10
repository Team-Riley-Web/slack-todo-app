import { listSpaces } from '@tr/task-core';
import { getDb } from '@/db';
import { requireUser } from '@/user';
import { parseFilters } from '@/data/filters';
import { waitingTasks, spaceSummary } from '@/data/tasks';
import { Shell } from '@/components/Shell';
import { FilterBar } from '@/components/FilterBar';
import { TaskList } from '@/components/TaskRow';
import { SectionCard } from '@/components/SectionCard';
import { assigneeLabels } from '@/lib/env';

export default async function WaitingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const filters = parseFilters(await searchParams);
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
      title="Waiting / blocked"
      subtitle="Parked on purpose, so they stay out of the open list."
      toolbar={
        <FilterBar
          path="/waiting"
          filters={filters}
          spaces={spaces}
          show={['search']}
        />
      }
    >
      <SectionCard label="Waiting" count={rows.length}>
        <TaskList
          rows={rows}
          empty="Nothing is waiting."
          showAge
          assigneeLabels={assigneeLabels()}
        />
      </SectionCard>
    </Shell>
  );
}
