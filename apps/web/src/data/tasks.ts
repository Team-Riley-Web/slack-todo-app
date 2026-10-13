import type { Db } from '@tr/db';
import {
  completedBetween, listSpaces, listTasks, type Space, type Task,
} from '@tr/task-core';
import type { TaskFilters } from './filters.js';
import { timeZone } from '../lib/env.js';

export interface TaskRow {
  task: Task;
  space: Space;
}

export interface SpaceSummaryRow {
  space: Space;
  open: number;
  waiting: number;
  completed: number;
}

/**
 * Every read in this file delegates to `task-core`. The web app adds no query
 * logic of its own — filters are translated into `ListTasksFilter` and resolved
 * in SQL, never by fetching everything and filtering in JavaScript.
 */
async function spacesById(db: Db): Promise<Map<string, Space>> {
  return new Map((await listSpaces(db)).map((s) => [s.id, s]));
}

async function spaceIdForSlug(db: Db, slug: string | undefined): Promise<string | undefined> {
  if (!slug) return undefined;
  const spaces = await listSpaces(db);
  return spaces.find((s) => s.slug === slug)?.id;
}

function attach(tasks: Task[], spaces: Map<string, Space>): TaskRow[] {
  return tasks.flatMap((task) => {
    const space = spaces.get(task.space_id);
    return space ? [{ task, space }] : [];
  });
}

/** Open tasks across every Space, narrowed by whatever filters are in the URL. */
export async function myTasks(db: Db, filters: TaskFilters): Promise<TaskRow[]> {
  const spaceId = await spaceIdForSlug(db, filters.space);
  // An unknown slug must return nothing rather than silently ignoring the
  // filter and showing everything.
  if (filters.space && !spaceId) return [];

  const tasks = await listTasks(db, {
    spaceId,
    assigneeId: filters.assignee,
    titleContains: filters.q,
    due: filters.due,
    // "Today" ends at midnight in the app's zone, not 24 hours from now.
    timeZone: timeZone(),
    ...(filters.status
      ? { status: filters.status }
      : { actionableOnly: true }),
  });
  return attach(tasks, await spacesById(db));
}

/** Every waiting task, cross-Space. */
export async function waitingTasks(db: Db, filters: TaskFilters): Promise<TaskRow[]> {
  const spaceId = await spaceIdForSlug(db, filters.space);
  if (filters.space && !spaceId) return [];

  const tasks = await listTasks(db, {
    status: 'waiting',
    spaceId,
    assigneeId: filters.assignee,
    titleContains: filters.q,
  });
  return attach(tasks, await spacesById(db));
}

/**
 * Completed history, newest completion first.
 *
 * The date range is half-open — `from` inclusive, `to` exclusive — matching
 * `completedBetween`, so two adjacent ranges never show the same task twice.
 */
export async function history(db: Db, filters: TaskFilters): Promise<TaskRow[]> {
  const spaceId = await spaceIdForSlug(db, filters.space);
  if (filters.space && !spaceId) return [];

  const spaces = await spacesById(db);

  if (filters.from || filters.to) {
    const from = filters.from ? new Date(`${filters.from}T00:00:00Z`) : new Date(0);
    const to = filters.to
      ? new Date(`${filters.to}T00:00:00Z`)
      : new Date(Date.now() + 86_400_000);
    const tasks = await completedBetween(db, from, to, { spaceId });
    const filtered = tasks.filter((t) => matchesText(t, filters.q) && matchesAssignee(t, filters.assignee));
    return attach(filtered.reverse(), spaces);
  }

  const tasks = await listTasks(db, {
    status: 'completed',
    spaceId,
    assigneeId: filters.assignee,
    titleContains: filters.q,
    limit: 200,
  });
  // listTasks orders by due date then creation; history reads better newest-first
  // by completion.
  const sorted = [...tasks].sort(
    (a, b) => (b.completed_at?.getTime() ?? 0) - (a.completed_at?.getTime() ?? 0)
  );
  return attach(sorted, spaces);
}

function matchesText(task: Task, q: string | undefined): boolean {
  if (!q) return true;
  return task.title.toLowerCase().includes(q.trim().toLowerCase());
}

function matchesAssignee(task: Task, assignee: string | undefined): boolean {
  if (!assignee) return true;
  return task.assignee_id === assignee;
}

/**
 * Every Space with its counts.
 *
 * Unlike the Slack `/tasks` summary, this includes Spaces with nothing in them:
 * the Spaces page is a place to go and add a task, so an empty Space still needs
 * a row.
 */
export async function spaceSummary(db: Db): Promise<SpaceSummaryRow[]> {
  const spaces = await listSpaces(db);
  const { rows } = await db.query<{
    space_id: string; open: string; waiting: string; completed: string;
  }>(
    `SELECT space_id,
            COUNT(*) FILTER (WHERE status = 'open')      AS open,
            COUNT(*) FILTER (WHERE status = 'waiting')   AS waiting,
            COUNT(*) FILTER (WHERE status = 'completed') AS completed
       FROM tasks GROUP BY space_id`
  );
  const counts = new Map(rows.map((r) => [r.space_id, r]));

  return spaces.map((space) => {
    const row = counts.get(space.id);
    return {
      space,
      open: Number(row?.open ?? 0),
      waiting: Number(row?.waiting ?? 0),
      completed: Number(row?.completed ?? 0),
    };
  });
}

/** Distinct assignee ids currently in use, for the filter dropdown. */
export async function knownAssignees(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ assignee_id: string }>(
    `SELECT DISTINCT assignee_id FROM tasks
      WHERE assignee_id IS NOT NULL ORDER BY assignee_id`
  );
  return rows.map((r) => r.assignee_id);
}
