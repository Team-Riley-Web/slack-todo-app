import type { Db } from '@tr/db';
import { createTask, getTask } from '@tr/task-core';
import { getBatch, getStagedRows, requireState, setState, verdictCounts } from './batches.js';
import { ImportStateError } from './errors.js';
import type { AuditAction, AuditRow, ImportReport, StagedRow } from './types.js';

/**
 * The human gate. `importBatch` refuses any batch that is not CONFIRMED, so
 * "explicit confirmation required before write" is a property of the state
 * machine rather than a convention a caller could forget.
 */
export async function confirmBatch(
  db: Db, batchId: string, actor: { id: string | null }
): Promise<void> {
  if (!actor.id) throw new Error('confirmBatch requires an actor id');
  await requireState(db, batchId, ['ANALYZED']);
  await db.query(
    `UPDATE import_batches
        SET state = 'CONFIRMED', confirmed_by = $2, confirmed_at = now()
      WHERE id = $1`,
    [batchId, actor.id]
  );
}

async function audit(
  db: Db,
  batchId: string,
  row: StagedRow,
  action: AuditAction,
  canonicalTaskId: string | null,
  reason: string | null
): Promise<void> {
  await db.query(
    `INSERT INTO import_audit
       (batch_id, source_type, source_record_id, canonical_task_id, action, reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [batchId, row.source_type, row.idempotency_key ?? row.source_record_id,
     canonicalTaskId, action, reason]
  );
}

const AUDIT_FOR: Record<string, AuditAction> = {
  SKIP_DUPLICATE: 'SKIPPED_DUPLICATE',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  INVALID: 'FAILED',
};

/**
 * Writes a confirmed batch.
 *
 * Everything happens inside one transaction, so a failure anywhere leaves zero
 * tasks written rather than a half-imported file. After the transaction
 * commits, every written row is read back and compared before the batch may
 * report success.
 */
export async function importBatch(db: Db, batchId: string): Promise<ImportReport> {
  const batch = await requireState(db, batchId, ['CONFIRMED']);

  const written: Array<{ row: StagedRow; taskId: string }> = [];

  await db.transaction(async (tx) => {
    const rows = await getStagedRows(tx, batchId);

    for (const row of rows) {
      if (row.verdict !== 'READY') {
        const action = AUDIT_FOR[row.verdict ?? 'INVALID'] ?? 'FAILED';
        await audit(tx, batchId, row, action, row.duplicate_task_id, row.reason);
        continue;
      }

      /*
       * task-core owns the write. The title reaches it unchanged from staging,
       * and `preserveCase` keeps it that way: an import reproduces records
       * someone already wrote, so a lowercase opening letter there is history
       * rather than a typo to tidy. The idempotency key is derived from the
       * source title, so rewriting it here would also make a re-import look
       * like a different record.
       */
      const task = await createTask(tx, {
        title: row.title,
        preserveCase: true,
        spaceId: row.resolved_space_id!,
        assigneeId: row.resolved_assignee_id,
        dueAt: row.resolved_due_at,
        sourcePlatform: row.source_type,
        createdBy: batch.created_by,
        details: typeof row.source_metadata?.details === 'string'
          ? (row.source_metadata.details as string)
          : null,
      });

      /**
       * Provenance and historical timestamps that createTask does not accept.
       * A deliberate, documented exception to "only task-core writes tasks":
       * this SET list contains no `title`, and a test asserts that.
       */
      await tx.query(
        `UPDATE tasks
            SET source_external_id = $2,
                import_batch_id = $3,
                status = $4,
                waiting_on = $5,
                created_at = COALESCE($6, created_at),
                completed_at = CASE WHEN $4 = 'completed'
                                    THEN COALESCE($7, now()) ELSE NULL END
          WHERE id = $1`,
        [
          task.id,
          row.idempotency_key,
          batchId,
          row.resolved_status,
          row.resolved_status === 'waiting' ? row.waiting_on : null,
          row.resolved_created_at,
          row.resolved_completed_at,
        ]
      );

      await tx.query(
        `UPDATE import_staging SET canonical_task_id = $2 WHERE id = $1`,
        [row.id, task.id]
      );
      await audit(tx, batchId, row, 'IMPORTED', task.id, null);
      written.push({ row, taskId: task.id });
    }

    await tx.query(
      `UPDATE import_batches SET state = 'IMPORTED', imported_at = now() WHERE id = $1`,
      [batchId]
    );
  });

  const verification = await verifyBatch(db, batchId);
  const counts = await verdictCounts(db, batchId);
  const rows = await getAudit(db, batchId);

  return {
    batchId,
    imported: written.length - verification.failed.length,
    skipped: counts.SKIP_DUPLICATE,
    needsReview: counts.NEEDS_REVIEW,
    failed: counts.INVALID + verification.failed.length,
    records: rows.map((r) => ({
      sourceRecordId: r.source_record_id,
      canonicalTaskId: r.canonical_task_id,
      action: r.action,
      reason: r.reason,
    })),
    importedAt: new Date().toISOString(),
  };
}

/**
 * Reads every imported task back and compares it against its staged row.
 *
 * The title comparison is byte-exact. Success is never reported on a write that
 * was not verified — a mismatch is audited as FAILED and surfaces in the report.
 */
export async function verifyBatch(
  db: Db, batchId: string
): Promise<{ verified: number; failed: string[] }> {
  const rows = await getStagedRows(db, batchId);
  const failed: string[] = [];
  let verified = 0;

  for (const row of rows) {
    if (row.verdict !== 'READY' || !row.canonical_task_id) continue;

    const task = await getTask(db, row.canonical_task_id).catch(() => null);
    const problems: string[] = [];

    if (!task) {
      problems.push('task not found after write');
    } else {
      if (task.title !== row.title) problems.push('title does not match source');
      if (task.space_id !== row.resolved_space_id) problems.push('space does not match');
      if (task.status !== row.resolved_status) problems.push('status does not match');
      if ((task.source_external_id ?? null) !== (row.idempotency_key ?? null)) {
        problems.push('source id does not match');
      }
      const wantDue = row.resolved_due_at?.getTime() ?? null;
      if ((task.due_at?.getTime() ?? null) !== wantDue) problems.push('due date does not match');
      if (row.resolved_status === 'completed' && !task.completed_at) {
        problems.push('completed task has no completed_at');
      }
    }

    if (problems.length > 0) {
      failed.push(row.canonical_task_id);
      await audit(db, batchId, row, 'FAILED', row.canonical_task_id, problems.join('; '));
    } else {
      verified += 1;
    }
  }

  return { verified, failed };
}

export async function getAudit(db: Db, batchId: string): Promise<AuditRow[]> {
  const { rows } = await db.query<AuditRow>(
    `SELECT id, batch_id, source_type, source_record_id, canonical_task_id,
            action, reason, created_at
       FROM import_audit WHERE batch_id = $1 ORDER BY created_at, id`,
    [batchId]
  );
  return rows;
}

/** Marks an unconfirmed batch abandoned, so it can never be imported later. */
export async function abortBatch(db: Db, batchId: string): Promise<void> {
  const batch = await getBatch(db, batchId);
  if (!batch) return;
  if (batch.state === 'IMPORTED' || batch.state === 'ROLLED_BACK') {
    throw new ImportStateError(batchId, batch.state, 'an unimported state');
  }
  await setState(db, batchId, 'ABORTED');
}
