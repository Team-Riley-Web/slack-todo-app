import type { Db } from '@tr/db';
import { ImportStateError } from './errors.js';
import type {
  BatchState, ImportBatch, ImportMapping, ImportSourceType, StagedRow, StagingRow, Verdict,
} from './types.js';

const BATCH_COLS = `id, source_type, filename, state, mapping, row_count,
                    created_by, created_at, confirmed_by, confirmed_at,
                    imported_at, rolled_back_at`;

const STAGED_COLS = `id, batch_id, row_number, source_type, source_record_id, title,
                     space, list_state, assignee, due_at, waiting_on, created_at,
                     completed_at, status, source_metadata, resolved_space_id,
                     resolved_assignee_id, resolved_status, resolved_due_at,
                     resolved_created_at, resolved_completed_at, idempotency_key,
                     verdict, reason, duplicate_task_id, canonical_task_id`;

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  return typeof value === 'string' ? (JSON.parse(value) as T) : (value as T);
}

export async function createBatch(
  db: Db,
  args: {
    sourceType: ImportSourceType;
    filename?: string | null;
    createdBy?: string | null;
  }
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO import_batches (source_type, filename, created_by)
     VALUES ($1, $2, $3) RETURNING id`,
    [args.sourceType, args.filename ?? null, args.createdBy ?? null]
  );
  return rows[0]!.id;
}

export async function getBatch(db: Db, batchId: string): Promise<ImportBatch | null> {
  const { rows } = await db.query<ImportBatch>(
    `SELECT ${BATCH_COLS} FROM import_batches WHERE id = $1`, [batchId]
  );
  const row = rows[0];
  if (!row) return null;
  return { ...row, mapping: parseJson<ImportMapping>(row.mapping, {}) };
}

/** Throws unless the batch is in one of the permitted states. */
export async function requireState(
  db: Db, batchId: string, allowed: BatchState[]
): Promise<ImportBatch> {
  const batch = await getBatch(db, batchId);
  if (!batch) throw new ImportStateError(batchId, 'missing', allowed.join(' or '));
  if (!allowed.includes(batch.state)) {
    throw new ImportStateError(batchId, batch.state, allowed.join(' or '));
  }
  return batch;
}

export async function setState(
  db: Db, batchId: string, state: BatchState
): Promise<void> {
  await db.query(`UPDATE import_batches SET state = $2 WHERE id = $1`, [batchId, state]);
}

export async function listBatches(db: Db, limit = 50): Promise<ImportBatch[]> {
  const { rows } = await db.query<ImportBatch>(
    `SELECT ${BATCH_COLS} FROM import_batches ORDER BY created_at DESC LIMIT $1`,
    [Math.min(Math.max(1, Math.floor(limit)), 200)]
  );
  return rows.map((r) => ({ ...r, mapping: parseJson<ImportMapping>(r.mapping, {}) }));
}

/**
 * Writes the parsed rows into staging. Nothing here touches `tasks`, and the
 * title column receives the source bytes unchanged.
 */
export async function stageRows(
  db: Db, batchId: string, rows: StagingRow[]
): Promise<number> {
  await requireState(db, batchId, ['PARSED']);
  for (const row of rows) {
    await db.query(
      `INSERT INTO import_staging
         (batch_id, row_number, source_type, source_record_id, title, space,
          list_state, assignee, due_at, waiting_on, created_at, completed_at,
          status, source_metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
      [
        batchId, row.rowNumber, row.sourceType, row.sourceRecordId, row.title,
        row.space, row.listState, row.assignee, row.dueAt, row.waitingOn,
        row.createdAt, row.completedAt, row.status,
        JSON.stringify(row.sourceMetadata ?? {}),
      ]
    );
  }
  await db.query(`UPDATE import_batches SET row_count = $2 WHERE id = $1`, [
    batchId, rows.length,
  ]);
  return rows.length;
}

export async function getStagedRows(
  db: Db, batchId: string, verdict?: Verdict
): Promise<StagedRow[]> {
  const params: unknown[] = [batchId];
  let clause = '';
  if (verdict) {
    params.push(verdict);
    clause = ` AND verdict = $2`;
  }
  const { rows } = await db.query<StagedRow>(
    `SELECT ${STAGED_COLS} FROM import_staging
      WHERE batch_id = $1${clause} ORDER BY row_number`,
    params
  );
  return rows.map((r) => ({
    ...r,
    source_metadata: parseJson<Record<string, unknown>>(r.source_metadata, {}),
  }));
}

export async function verdictCounts(
  db: Db, batchId: string
): Promise<Record<Verdict, number>> {
  const { rows } = await db.query<{ verdict: Verdict | null; n: number }>(
    `SELECT verdict, COUNT(*)::int AS n FROM import_staging
      WHERE batch_id = $1 GROUP BY verdict`,
    [batchId]
  );
  const counts: Record<Verdict, number> = {
    READY: 0, SKIP_DUPLICATE: 0, NEEDS_REVIEW: 0, INVALID: 0,
  };
  for (const row of rows) {
    if (row.verdict) counts[row.verdict] = Number(row.n);
  }
  return counts;
}
