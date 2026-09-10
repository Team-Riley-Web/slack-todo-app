import type { Db } from '@tr/db';
import type { Task } from './types.js';

const COLS = `id, title, space_id, list_id, assignee_id, status, due_at, waiting_on,
              details, created_at, completed_at, source_platform,
              source_channel_id, source_message_ts, created_by,
              source_external_id, import_batch_id`;

export interface SpaceOpenCount {
  space_id: string;
  space_name: string;
  open: number;
}

/** Open tasks per Space. Waiting and completed are excluded. */
export async function openCountBySpace(db: Db): Promise<SpaceOpenCount[]> {
  const { rows } = await db.query<{ space_id: string; space_name: string; open: string }>(
    `SELECT s.id AS space_id, s.name AS space_name, COUNT(t.id)::int AS open
       FROM spaces s
       LEFT JOIN tasks t ON t.space_id = s.id AND t.status = 'open'
      GROUP BY s.id, s.name
      HAVING COUNT(t.id) > 0
      ORDER BY s.name`
  );
  return rows.map((r) => ({
    space_id: r.space_id, space_name: r.space_name, open: Number(r.open),
  }));
}

/**
 * Completed tasks in a half-open range: `from` inclusive, `to` exclusive.
 * Half-open avoids the classic double-count when two ranges abut.
 */
export async function completedBetween(
  db: Db, from: Date, to: Date, opts: { spaceId?: string } = {}
): Promise<Task[]> {
  const params: unknown[] = [from, to];
  let clause = '';
  if (opts.spaceId) {
    params.push(opts.spaceId);
    clause = ` AND space_id = $${params.length}`;
  }
  const { rows } = await db.query<Task>(
    `SELECT ${COLS} FROM tasks
      WHERE status = 'completed'
        AND completed_at >= $1 AND completed_at < $2${clause}
      ORDER BY completed_at`,
    params
  );
  return rows;
}

export async function createdBetween(
  db: Db, from: Date, to: Date
): Promise<Task[]> {
  const { rows } = await db.query<Task>(
    `SELECT ${COLS} FROM tasks
      WHERE created_at >= $1 AND created_at < $2
      ORDER BY created_at`,
    [from, to]
  );
  return rows;
}

/** Start of the current week, Monday 00:00 UTC. */
export function startOfWeek(now = new Date()): Date {
  const d = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()
  ));
  const shift = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - shift);
  return d;
}

export function createdThisWeek(db: Db, now = new Date()): Promise<Task[]> {
  const from = startOfWeek(now);
  const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
  return createdBetween(db, from, to);
}

export function completedThisWeek(db: Db, now = new Date()): Promise<Task[]> {
  const from = startOfWeek(now);
  const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
  return completedBetween(db, from, to);
}

/**
 * Mean age in days of tasks that are still open. Completed tasks are excluded —
 * including them would make the number drift down as work gets finished, which
 * is the opposite of what it is for.
 */
export async function averageTaskAgeDays(
  db: Db, opts: { spaceId?: string } = {}
): Promise<number | null> {
  const params: unknown[] = [];
  let clause = '';
  if (opts.spaceId) {
    params.push(opts.spaceId);
    clause = ` AND space_id = $${params.length}`;
  }
  const { rows } = await db.query<{ avg: string | null }>(
    `SELECT AVG(EXTRACT(EPOCH FROM (now() - created_at)) / 86400) AS avg
       FROM tasks WHERE status = 'open'${clause}`,
    params
  );
  const value = rows[0]?.avg;
  return value == null ? null : Number(value);
}

/**
 * Open tasks older than `days`. Waiting tasks are excluded: they are parked on
 * purpose, so counting them as stale would bury the ones that are genuinely
 * being neglected.
 */
export async function staleTasks(
  db: Db, days = 30, opts: { spaceId?: string } = {}
): Promise<Task[]> {
  const threshold = Math.max(0, Math.floor(days));
  const params: unknown[] = [String(threshold)];
  let clause = '';
  if (opts.spaceId) {
    params.push(opts.spaceId);
    clause = ` AND space_id = $${params.length}`;
  }
  const { rows } = await db.query<Task>(
    `SELECT ${COLS} FROM tasks
      WHERE status = 'open'
        AND created_at < now() - ($1 || ' days')::interval${clause}
      ORDER BY created_at`,
    params
  );
  return rows;
}
