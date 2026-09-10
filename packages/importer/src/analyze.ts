import type { Db } from '@tr/db';
import { isDailyAnchor } from './anchors.js';
import { requireState, setState, getStagedRows, verdictCounts } from './batches.js';
import type { StagedRow, Verdict } from './types.js';

interface Decision {
  verdict: Verdict;
  reason: string | null;
  duplicateTaskId: string | null;
}

/**
 * Decides one row's fate. Every comparison is exact equality — there is no
 * LIKE, no similarity function, and no distance function anywhere in this
 * package. Ordering is fixed and load-bearing, so a row matching more than one
 * rule always gets the same answer.
 */
async function decide(db: Db, row: StagedRow): Promise<Decision> {
  // --- Invalid, checked first: a row that cannot become a task at all.
  if (row.title.trim().length === 0) {
    return { verdict: 'INVALID', reason: 'title is empty', duplicateTaskId: null };
  }
  if (isDailyAnchor(row.title)) {
    return {
      verdict: 'INVALID',
      reason: 'daily anchor, tracked externally',
      duplicateTaskId: null,
    };
  }
  if (!row.resolved_space_id) {
    return {
      verdict: 'INVALID',
      reason: `source category ${JSON.stringify(row.space ?? null)} is not mapped to a Space`,
      duplicateTaskId: null,
    };
  }
  if (!row.resolved_status) {
    return {
      verdict: 'INVALID',
      reason: `source status ${JSON.stringify(row.status ?? null)} is not mapped to a status`,
      duplicateTaskId: null,
    };
  }

  const key = row.idempotency_key;

  // --- Rule 1: this exact source record was already imported AND its task
  // still exists.
  //
  // The join to `tasks` is load-bearing. Audit rows deliberately survive
  // rollback, so without it a rolled-back batch would permanently block
  // re-importing the same file — defeating the point of rolling back to fix a
  // mapping — and would hand analysis a task id that no longer exists.
  if (key) {
    const { rows } = await db.query<{ canonical_task_id: string }>(
      `SELECT a.canonical_task_id
         FROM import_audit a
         JOIN tasks t ON t.id = a.canonical_task_id
        WHERE a.source_type = $1 AND a.source_record_id = $2
          AND a.action = 'IMPORTED'
        LIMIT 1`,
      [row.source_type, key]
    );
    if (rows[0]) {
      return {
        verdict: 'SKIP_DUPLICATE',
        reason: 'already imported in an earlier batch',
        duplicateTaskId: rows[0].canonical_task_id,
      };
    }
  }

  // --- Rule 2: a task already carries this external id.
  if (key) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM tasks
        WHERE source_platform = $1 AND source_external_id = $2 LIMIT 1`,
      [row.source_type, key]
    );
    if (rows[0]) {
      return {
        verdict: 'SKIP_DUPLICATE',
        reason: 'a task already carries this source id',
        duplicateTaskId: rows[0].id,
      };
    }
  }

  // --- Rule 3: exact title, same Space, same active status.
  //
  // Deliberately NOT an auto-skip. The match is exact but the conclusion is
  // not: two genuinely different tasks can share a title inside one Space, and
  // merging them silently is the failure this importer exists to prevent. A
  // human decides.
  const { rows: sameTitle } = await db.query<{ id: string }>(
    `SELECT id FROM tasks
      WHERE title = $1 AND space_id = $2 AND status = $3
      LIMIT 1`,
    [row.title, row.resolved_space_id, row.resolved_status]
  );
  if (sameTitle[0]) {
    return {
      verdict: 'NEEDS_REVIEW',
      reason: 'a task with this exact title already exists in this Space with the same status',
      duplicateTaskId: sameTitle[0].id,
    };
  }

  return { verdict: 'READY', reason: null, duplicateTaskId: null };
}

/**
 * Assigns a verdict to every staged row. Idempotent: running it again on the
 * same batch produces the same verdicts and creates no extra rows.
 */
export async function analyzeBatch(
  db: Db, batchId: string
): Promise<Record<Verdict, number>> {
  await requireState(db, batchId, ['MAPPED', 'ANALYZED']);
  const rows = await getStagedRows(db, batchId);

  // Titles seen earlier in THIS batch, so a file containing the same record
  // twice does not import it twice.
  const seen = new Map<string, number>();

  for (const row of rows) {
    let decision = await decide(db, row);

    if (decision.verdict === 'READY' && row.idempotency_key) {
      const earlier = seen.get(row.idempotency_key);
      if (earlier !== undefined) {
        decision = {
          verdict: 'SKIP_DUPLICATE',
          reason: `duplicate of row ${earlier} in this file`,
          duplicateTaskId: null,
        };
      } else {
        seen.set(row.idempotency_key, row.row_number);
      }
    }

    await db.query(
      `UPDATE import_staging
          SET verdict = $2, reason = $3, duplicate_task_id = $4
        WHERE id = $1`,
      [row.id, decision.verdict, decision.reason, decision.duplicateTaskId]
    );
  }

  await setState(db, batchId, 'ANALYZED');
  return verdictCounts(db, batchId);
}

/** The rows a human needs to look at before importing. */
export async function getConflicts(db: Db, batchId: string): Promise<StagedRow[]> {
  const all = await getStagedRows(db, batchId);
  return all.filter(
    (r) => r.verdict === 'NEEDS_REVIEW' || r.verdict === 'INVALID'
  );
}
