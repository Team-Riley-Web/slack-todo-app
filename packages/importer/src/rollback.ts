import type { Db } from '@tr/db';
import { requireState } from './batches.js';
import type { RollbackResult } from './types.js';

/**
 * Undoes an import batch by hard-deleting the tasks it created.
 *
 * Hard delete is the chosen behaviour, recorded in the design spec. It is the
 * one place this system removes task rows, and it is scoped to untouched rows
 * from a single identified batch — a different act from deleting real work.
 *
 * Two guards:
 *
 * 1. A task carrying any `task_events` row beyond its own `created` entry has
 *    been worked on since it was imported. Rollback refuses it and reports it,
 *    unless called with `force`.
 *
 *    Keyed on the event KIND, not its source string: createTask tags its
 *    `created` event with the source platform (`csv`, `workast`), so a check
 *    for "source is not import" would have flagged the import's own creation
 *    event and refused every row. Any later human action adds a `completed`,
 *    `reopened`, `moved`, `details`, or `edited` event.
 * 2. `import_audit` rows are never deleted. Each affected row gains a
 *    ROLLED_BACK entry, so the record of what happened survives the tasks.
 *
 * `slack_cards` holds task ids in an array with no foreign key, and the card
 * renderer already skips ids that no longer resolve, so a rolled-back task
 * simply disappears from its card.
 */
export async function rollbackBatch(
  db: Db, batchId: string, opts: { force?: boolean } = {}
): Promise<RollbackResult> {
  await requireState(db, batchId, ['IMPORTED']);

  return db.transaction(async (tx) => {
    const { rows: candidates } = await tx.query<{ id: string; touched: boolean }>(
      `SELECT t.id,
              EXISTS (
                SELECT 1 FROM task_events e
                 WHERE e.task_id = t.id AND e.event <> 'created'
              ) AS touched
         FROM tasks t
        WHERE t.import_batch_id = $1
        ORDER BY t.created_at, t.id`,
      [batchId]
    );

    const deletable: string[] = [];
    const refused: string[] = [];
    for (const row of candidates) {
      if (row.touched && !opts.force) refused.push(row.id);
      else deletable.push(row.id);
    }

    if (deletable.length > 0) {
      // Events describe rows that will not exist; they go with them.
      await tx.query(`DELETE FROM task_events WHERE task_id = ANY($1::uuid[])`, [deletable]);
      await tx.query(`DELETE FROM tasks WHERE id = ANY($1::uuid[])`, [deletable]);

      await tx.query(
        `INSERT INTO import_audit
           (batch_id, source_type, source_record_id, canonical_task_id, action, reason)
         SELECT a.batch_id, a.source_type, a.source_record_id, a.canonical_task_id,
                'ROLLED_BACK', 'task deleted by rollback'
           FROM import_audit a
          WHERE a.batch_id = $1 AND a.action = 'IMPORTED'
            AND a.canonical_task_id = ANY($2::uuid[])`,
        [batchId, deletable]
      );
    }

    for (const id of refused) {
      await tx.query(
        `INSERT INTO import_audit
           (batch_id, source_type, source_record_id, canonical_task_id, action, reason)
         SELECT a.batch_id, a.source_type, a.source_record_id, a.canonical_task_id,
                'ROLLED_BACK', 'refused: task edited since import'
           FROM import_audit a
          WHERE a.batch_id = $1 AND a.action = 'IMPORTED' AND a.canonical_task_id = $2`,
        [batchId, id]
      );
    }

    await tx.query(
      `UPDATE import_batches
          SET state = 'ROLLED_BACK', rolled_back_at = now()
        WHERE id = $1`,
      [batchId]
    );

    return {
      batchId,
      deleted: deletable.length,
      refused: refused.length,
      refusedTaskIds: refused,
    };
  });
}
