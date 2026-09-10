import type { Db } from '@tr/db';
import type { Task, TaskStatus } from './types.js';

const COLS = `id, title, space_id, list_id, assignee_id, status, due_at, waiting_on,
              details, created_at, completed_at, source_platform,
              source_channel_id, source_message_ts, created_by,
              source_external_id, import_batch_id`;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/**
 * A non-numeric `?limit=` reached SQL as `LIMIT NaN` and errored the request.
 * Anything not a finite positive number falls back to the default.
 */
function sanitizeLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

export type DueBucket = 'overdue' | 'today' | 'week' | 'none';

export interface ListTasksFilter {
  spaceId?: string;
  status?: TaskStatus | TaskStatus[];
  /** open only — excludes both waiting and completed. Daily-priority semantics. */
  actionableOnly?: boolean;
  assigneeId?: string;
  /**
   * Case-insensitive substring of the title. LIKE metacharacters are escaped,
   * so a search for "50%" means literally that.
   */
  titleContains?: string;
  /** Bucketed due date, resolved in SQL against now(). */
  due?: DueBucket;
  limit?: number;
}

/** `%`, `_`, and `\` are LIKE metacharacters and must be literal in a search. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function listTasks(db: Db, filter: ListTasksFilter = {}): Promise<Task[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.actionableOnly) {
    where.push(`status = 'open'`);
  } else if (filter.status) {
    const list = Array.isArray(filter.status) ? filter.status : [filter.status];
    params.push(list);
    where.push(`status = ANY($${params.length})`);
  }
  if (filter.spaceId) { params.push(filter.spaceId); where.push(`space_id = $${params.length}`); }
  if (filter.assigneeId) { params.push(filter.assigneeId); where.push(`assignee_id = $${params.length}`); }

  const search = filter.titleContains?.trim();
  if (search) {
    params.push(escapeLike(search.toLowerCase()));
    where.push(`lower(title) LIKE '%' || $${params.length} || '%' ESCAPE '\\'`);
  }

  if (filter.due === 'none') {
    where.push(`due_at IS NULL`);
  } else if (filter.due === 'overdue') {
    where.push(`due_at IS NOT NULL AND due_at < now()`);
  } else if (filter.due === 'today') {
    where.push(`due_at IS NOT NULL AND due_at < now() + interval '1 day'`);
  } else if (filter.due === 'week') {
    where.push(`due_at IS NOT NULL AND due_at < now() + interval '7 days'`);
  }

  params.push(sanitizeLimit(filter.limit));
  const { rows } = await db.query<Task>(
    `SELECT ${COLS} FROM tasks
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY due_at ASC NULLS LAST, created_at ASC
      LIMIT $${params.length}`,
    params
  );
  return rows;
}

export function listWaiting(db: Db, filter: { spaceId?: string } = {}): Promise<Task[]> {
  return listTasks(db, { ...filter, status: 'waiting' });
}

export interface SpaceCount {
  space_id: string;
  space_name: string;
  open: number;
  waiting: number;
}

/** Counts exclude completed tasks entirely. Spaces with nothing actionable are omitted. */
export async function getTaskCounts(
  db: Db, filter: { assigneeId?: string } = {}
): Promise<SpaceCount[]> {
  const params: unknown[] = [];
  let assigneeClause = '';
  if (filter.assigneeId) {
    params.push(filter.assigneeId);
    assigneeClause = `AND t.assignee_id = $${params.length}`;
  }
  const { rows } = await db.query<{
    space_id: string; space_name: string; open: string; waiting: string;
  }>(
    `SELECT s.id AS space_id, s.name AS space_name,
            COUNT(*) FILTER (WHERE t.status = 'open')    AS open,
            COUNT(*) FILTER (WHERE t.status = 'waiting') AS waiting
       FROM spaces s
       JOIN tasks t ON t.space_id = s.id AND t.status IN ('open','waiting') ${assigneeClause}
      GROUP BY s.id, s.name
      HAVING COUNT(*) > 0
      ORDER BY s.name`,
    params
  );
  return rows.map((r) => ({
    space_id: r.space_id,
    space_name: r.space_name,
    open: Number(r.open),
    waiting: Number(r.waiting),
  }));
}
