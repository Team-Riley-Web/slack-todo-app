import { listSpaces } from '@tr/task-core';
import { getDb } from '@/db';
import { requireUser } from '@/user';
import { parseFilters } from '@/data/filters';
import { myTasks, knownAssignees, spaceSummary } from '@/data/tasks';
import { Shell } from '@/components/Shell';
import { FilterBar } from '@/components/FilterBar';
import { TaskList } from '@/components/TaskRow';
import { SectionCard } from '@/components/SectionCard';
import { assigneeLabels } from '@/lib/env';

export default async function MyTasksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const filters = parseFilters(await searchParams);
  const db = await getDb();

  const [rows, spaces, assignees] = await Promise.all([
    myTasks(db, filters),
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
      current="/"
      who={user.name ?? user.slackUserId}
      spaces={railSpaces}
      railPath="/"
      activeSlug={filters.space ?? null}
      title="My tasks"
      subtitle={
        `${rows.length} ${rows.length === 1 ? 'task' : 'tasks'}` +
        (Object.keys(filters).length > 0 ? ' matching these filters' : ' open')
      }
      toolbar={
        <FilterBar
          path="/"
          filters={filters}
          spaces={spaces}
          assignees={assignees}
          assigneeLabels={assigneeLabels()}
          show={['search', 'status', 'due', 'assignee']}
        />
      }
    >
      <SectionCard label="Open" count={rows.length}>
        <TaskList
          rows={rows}
          empty="Nothing open. Capture something with /task in Slack."
          assigneeLabels={assigneeLabels()}
        />
      </SectionCard>
    </Shell>
  );
}
