import { listSpaces } from '@tr/task-core';
import { getDb } from '@/db';
import { requireUser } from '@/user';
import { parseFilters, todayFocusFilters } from '@/data/filters';
import { myTasks, knownAssignees, spaceSummary } from '@/data/tasks';
import { Shell } from '@/components/Shell';
import { FilterBar } from '@/components/FilterBar';
import { TaskList } from '@/components/TaskRow';
import { EditPane } from '@/components/EditPane';
import { SectionCard, ColumnHead } from '@/components/SectionCard';
import { assigneeLabels } from '@/lib/env';
import { sortRows, sortingFor } from '@/lib/sort';
import { spaceBySlug, shortSpaceName } from '@/lib/display';

export default async function MyTasksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Called for the gate, not for a value: it redirects when not signed in.
  await requireUser();
  const query = await searchParams;
  const filters = parseFilters(query);
  // Ordering comes from the URL's own params, never a page's derived
  // filters, so a header link reproduces exactly the view it sits on.
  const sortBy = parseFilters(query);
  const sorting = sortingFor('/', sortBy);
  const editing = Array.isArray(query.edit) ? query.edit[0] : query.edit;
  const db = await getDb();

  /*
   * Open and Waiting, both on this page, through the same query with an
   * explicit status each -- so the due chips, the assignee, search and the
   * Space narrow both halves identically. waitingTasks() was not used for the
   * second half because it ignores the due filter: choosing "Overdue" would
   * have narrowed Open and left Waiting untouched beneath it.
   */
  const todayFilters = todayFocusFilters(filters);
  const [rows, waiting, spaces, assignees, today] = await Promise.all([
    myTasks(db, { ...filters, status: 'open' }),
    myTasks(db, { ...filters, status: 'waiting' }),
    listSpaces(db),
    knownAssignees(db),
    todayFilters ? myTasks(db, todayFilters) : Promise.resolve(null),
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
      path="/"
      current="/"
      spaces={railSpaces}
      activeSlug={filters.space ?? null}
      searchPath="/"
      searchParams={query}
      title={only ? shortSpaceName(only) : "My Tasks"}
      toolbar={
        <FilterBar
          path="/"
          filters={filters}
          assignees={assignees}
          assigneeLabels={assigneeLabels()}
          show={['due', 'assignee']}
        />
      }
    >
      {only ? (
        /*
         * One Space: the page already names it, so Open and Waiting are the
         * only division left worth making. Unchanged.
         */
        <>
          {/*
           * No column band on a Space page: the summary above names the group
           * and carries its tone, so a repeated "OPEN" strip under it said the
           * same thing twice.
           */}
          <SectionCard label="Open" count={rows.length}
            showSpace={false} columns="none" tone="open">
            <TaskList
              rows={sortRows(rows, sortBy, assigneeLabels())}
              showSpace={false}
              empty="Nothing open. Capture something with /task in Slack."
              assigneeLabels={assigneeLabels()}
              basePath="/"
              params={query}
            />
          </SectionCard>

          {/* Below Open, with the columns that say what each task is stuck on. */}
          <SectionCard
            label="Waiting"
            count={waiting.length}
            showSpace={false}
            showWaiting
            columns="none"
            tone="waiting"
          >
            <TaskList
              rows={sortRows(waiting, sortBy, assigneeLabels())}
              showSpace={false}
              showWaiting
              empty="Nothing waiting."
              assigneeLabels={assigneeLabels()}
              basePath="/"
              params={query}
            />
          </SectionCard>
        </>
      ) : (
        /*
         * Every Space: one card per Space, the way the Slack card groups them.
         *
         * This replaced a single flat "Open" list with a Space column, which
         * made you read the same Space name down thirty rows to work out what
         * belonged together. The card names the Space once, so the column
         * comes off the rows entirely.
         *
         * Waiting tasks sit inside their own Space's card under a subheading
         * rather than in a separate list at the bottom of the page. Most
         * Spaces have none, so most cards are simply a list of tasks.
         *
         * Order follows `listSpaces`, the same order the rail and the Slack
         * digests use. A Space with nothing in it is omitted rather than shown
         * empty -- an empty card per idle client is noise, and the rail
         * already says which Spaces exist.
         */
        <>
          {/*
           * Today, first and outlined: what needs doing now, pulled out of
           * every Space into one list to work straight down.
           *
           * The one card on this page that keeps the Space column, because it
           * is the one card that mixes Spaces -- every card below names its
           * Space once in its title. Ticking a task here completes it
           * everywhere; its title opens the same edit pane, for a due date or
           * a move.
           *
           * The tasks also stay in their Space's card below. This is a lens
           * on the list, not a second list, so a Space's count never changes
           * because something in it happens to be due today.
           */}
          {today ? (
            <SectionCard
              featured
              sorting={sorting}
              label="Today"
              count={today.length}
              showSpace
            >
              <TaskList
                rows={sortRows(today, sortBy, assigneeLabels())}
                showSpace
                empty="Nothing due today."
                assigneeLabels={assigneeLabels()}
                basePath="/"
                params={query}
              />
            </SectionCard>
          ) : null}

          {spaces.map((space) => {
            const open = sortRows(
              rows.filter((r) => r.task.space_id === space.id), sortBy, assigneeLabels()
            );
            const blocked = sortRows(
              waiting.filter((r) => r.task.space_id === space.id), sortBy, assigneeLabels()
            );
            if (open.length + blocked.length === 0) return null;

            return (
              <SectionCard
                key={space.id}
                sorting={sorting}
                label={shortSpaceName(space)}
                count={open.length + blocked.length}
                showSpace={false}
                /*
                 * The card emits no band of its own. Each GROUP carries one,
                 * so a Space holding only blocked work shows a WAITING band
                 * and nothing else -- it used to show an empty OPEN band above
                 * it, labelling rows that were not there.
                 */
                columns="none"
              >
                {open.length > 0 ? (
                  <>
                    <ColumnHead
                      label="Open"
                      tone="open"
                      sorting={sorting}
                      showSpace={false}
                    />
                    <TaskList
                      rows={open}
                      showSpace={false}
                      empty=""
                      assigneeLabels={assigneeLabels()}
                      basePath="/"
                      params={query}
                    />
                  </>
                ) : null}
                {blocked.length > 0 ? (
                  <>
                    {/*
                      The same band as the one above the open rows, so the two
                      groups are told apart by their word and their tint rather
                      than by one being a header and the other a label. Waiting
                      rows keep the SAME columns, so both bands describe what is
                      under them. What a task waits on is still on /waiting and
                      in the edit pane.
                    */}
                    <ColumnHead
                      label="Waiting"
                      tone="waiting"
                      sorting={sorting}
                      showSpace={false}
                    />
                    <TaskList
                      rows={blocked}
                      showSpace={false}
                      empty=""
                      assigneeLabels={assigneeLabels()}
                      basePath="/"
                      params={query}
                    />
                  </>
                ) : null}
              </SectionCard>
            );
          })}
        </>
      )}

      {editing ? (
        <EditPane
          db={db}
          taskId={editing}
          basePath="/"
          params={query}
          assigneeLabels={assigneeLabels()}
        />
      ) : null}
    </Shell>
  );
}
