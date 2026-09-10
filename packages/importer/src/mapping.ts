import { DateTime } from 'luxon';
import type { Db } from '@tr/db';
import { findSpaceExact, type TaskStatus } from '@tr/task-core';
import { requireState, setState, getStagedRows } from './batches.js';
import { idempotencyKeyFor } from './keys.js';
import type { ImportMapping, StagedRow } from './types.js';

/**
 * Resolves a source date string to a timestamp.
 *
 * Accepts ISO, and `YYYY-MM-DD HH:mm:ss` with a separate timezone taken from
 * source metadata — the shape the Workast export uses
 * (`2026-11-13`, `09:00:00`, `America/Chicago`). A date with no time resolves
 * to midnight in the given zone. Anything unparseable resolves to null rather
 * than to a guess.
 */
export function resolveDate(
  raw: string | null | undefined,
  zone: string,
  timeOfDay?: string | null
): Date | null {
  if (!raw) return null;
  const text = raw.trim();
  if (text.length === 0) return null;

  const combined = timeOfDay && /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text}T${timeOfDay}`
    : text.replace(' ', 'T');

  const dt = DateTime.fromISO(combined, { zone });
  if (dt.isValid) return dt.toJSDate();

  const fallback = DateTime.fromISO(text, { zone });
  return fallback.isValid ? fallback.toJSDate() : null;
}

function metaString(meta: Record<string, unknown>, key: string): string | null {
  const value = meta?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Resolves a source status through the mapping, then through a small set of
 * literal defaults. Never inferred from text: an unmapped, unrecognised status
 * resolves to null and the row is flagged rather than assumed open.
 */
function resolveStatus(
  row: StagedRow, mapping: ImportMapping
): TaskStatus | null {
  const raw = row.status?.trim() ?? '';

  // An explicit waiting flag on the record beats a general status mapping.
  // The Workast export carries `status: pending` AND `waiting: true` on the
  // same row, so mapping pending -> open would otherwise silently drop the
  // waiting state of every parked task.
  if (row.source_metadata?.waiting === true) return 'waiting';
  if (row.waiting_on && row.waiting_on.trim().length > 0) return 'waiting';

  const mapped = mapping.statuses?.[raw] ?? mapping.statuses?.[raw.toLowerCase()];
  if (mapped) return mapped;

  const normalized = raw.toLowerCase();
  if (['open', 'pending', 'todo', 'to do', 'active', 'not started'].includes(normalized)) {
    return 'open';
  }
  if (['waiting', 'blocked', 'on hold'].includes(normalized)) return 'waiting';
  if (['completed', 'complete', 'done', 'closed', 'finished'].includes(normalized)) {
    return 'completed';
  }
  // A source completion timestamp is unambiguous evidence.
  if (row.completed_at && row.completed_at.trim().length > 0) return 'completed';
  if (raw.length === 0) return 'open';
  return null;
}

/**
 * Applies a mapping to every staged row in a batch.
 *
 * Writes only the `resolved_*` columns and the idempotency key. It never
 * touches `title` — a test asserts the title column is byte-identical before
 * and after.
 */
export async function applyMapping(
  db: Db,
  batchId: string,
  mapping: ImportMapping,
  opts: { timeZone?: string } = {}
): Promise<void> {
  await requireState(db, batchId, ['PARSED', 'MAPPED', 'ANALYZED']);
  const zone = opts.timeZone ?? 'America/Chicago';
  const rows = await getStagedRows(db, batchId);

  // Cache space lookups: an import typically has a handful of distinct
  // categories across thousands of rows.
  const spaceCache = new Map<string, string | null>();
  const resolveSpace = async (name: string | null): Promise<string | null> => {
    const key = name ?? '';
    if (spaceCache.has(key)) return spaceCache.get(key) ?? null;
    let id: string | null = null;
    if (name) {
      const mapped = mapping.spaces?.[name] ?? mapping.spaces?.[name.trim()];
      const target = mapped ?? name;
      id = (await findSpaceExact(db, target))?.id ?? null;
    } else if (mapping.defaultSpace) {
      id = (await findSpaceExact(db, mapping.defaultSpace))?.id ?? null;
    }
    spaceCache.set(key, id);
    return id;
  };

  for (const row of rows) {
    const spaceId = await resolveSpace(row.space);

    const assigneeRaw = row.assignee?.trim() ?? '';
    const assigneeId = assigneeRaw.length > 0
      ? (mapping.assignees?.[assigneeRaw] ?? mapping.assignees?.[assigneeRaw.toLowerCase()] ?? null)
      : null;

    const status = resolveStatus(row, mapping);

    const dueTime = metaString(row.source_metadata, 'due_time');
    const dueZone = metaString(row.source_metadata, 'due_timezone') ?? zone;
    const resolvedDue = resolveDate(row.due_at, dueZone, dueTime);
    const resolvedCreated = resolveDate(row.created_at, zone);
    const resolvedCompleted = resolveDate(row.completed_at, zone);

    const key = idempotencyKeyFor({
      rowNumber: row.row_number,
      sourceType: row.source_type,
      sourceRecordId: row.source_record_id,
      title: row.title,
      space: row.space,
      listState: row.list_state,
      assignee: row.assignee,
      dueAt: row.due_at,
      waitingOn: row.waiting_on,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      status: row.status,
      sourceMetadata: row.source_metadata,
    });

    await db.query(
      `UPDATE import_staging
          SET resolved_space_id = $2, resolved_assignee_id = $3,
              resolved_status = $4, resolved_due_at = $5,
              resolved_created_at = $6, resolved_completed_at = $7,
              idempotency_key = $8
        WHERE id = $1`,
      [row.id, spaceId, assigneeId, status, resolvedDue, resolvedCreated,
       resolvedCompleted, key]
    );
  }

  await db.query(
    `UPDATE import_batches SET mapping = $2::jsonb WHERE id = $1`,
    [batchId, JSON.stringify(mapping)]
  );
  await setState(db, batchId, 'MAPPED');
}

/** Source categories in a batch that the mapping does not resolve to a Space. */
export async function unmappedCategories(
  db: Db, batchId: string
): Promise<string[]> {
  const { rows } = await db.query<{ space: string | null }>(
    `SELECT DISTINCT space FROM import_staging
      WHERE batch_id = $1 AND resolved_space_id IS NULL
      ORDER BY space`,
    [batchId]
  );
  return rows.map((r) => r.space ?? '(none)');
}
