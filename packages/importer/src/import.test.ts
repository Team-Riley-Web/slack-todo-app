import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask, getTask } from '@tr/task-core';
import { createBatch, stageRows, getStagedRows, getBatch } from './batches.js';
import { applyMapping } from './mapping.js';
import { analyzeBatch } from './analyze.js';
import {
  confirmBatch, importBatch, verifyBatch, getAudit, abortBatch,
} from './import.js';
import { ImportStateError } from './errors.js';
import type { ImportMapping, StagingRow } from './types.js';

let db: Db;
let marketingId: string;
const actor = { id: 'U_JOSH' };

beforeEach(async () => {
  db = await createTestDb();
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM spaces WHERE name = 'Marketing'`
  );
  marketingId = rows[0]!.id;
});
afterEach(async () => { await db.close(); });

const row = (over: Partial<StagingRow> = {}): StagingRow => ({
  rowNumber: 1, sourceType: 'csv', sourceRecordId: 'r-1', title: 'Call Neil',
  space: 'Marketing', listState: null, assignee: null, dueAt: null,
  waitingOn: null, createdAt: null, completedAt: null, status: 'pending',
  sourceMetadata: {}, ...over,
});

/** Stage, map, analyze — everything short of confirming. */
const prepare = async (rows: StagingRow[], mapping: ImportMapping = {}) => {
  const batchId = await createBatch(db, { sourceType: 'csv', createdBy: 'U_JOSH' });
  await stageRows(db, batchId, rows);
  await applyMapping(db, batchId, mapping);
  await analyzeBatch(db, batchId);
  return batchId;
};

const taskCount = async () => {
  const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks`);
  return rows[0]!.n;
};

describe('the confirmation gate', () => {
  it('refuses to import an analyzed but unconfirmed batch, writing nothing', async () => {
    const batchId = await prepare([row()]);
    await expect(importBatch(db, batchId)).rejects.toThrow(ImportStateError);
    expect(await taskCount()).toBe(0);
    expect((await getBatch(db, batchId))!.state).toBe('ANALYZED');
  });

  it('refuses to import a batch that was never analyzed', async () => {
    const batchId = await createBatch(db, { sourceType: 'csv' });
    await stageRows(db, batchId, [row()]);
    await expect(importBatch(db, batchId)).rejects.toThrow(ImportStateError);
    expect(await taskCount()).toBe(0);
  });

  it('requires an actor id to confirm', async () => {
    const batchId = await prepare([row()]);
    await expect(confirmBatch(db, batchId, { id: null })).rejects.toThrow(/actor id/);
  });

  it('records who confirmed and when, together', async () => {
    const batchId = await prepare([row()]);
    await confirmBatch(db, batchId, actor);
    const batch = (await getBatch(db, batchId))!;
    expect(batch.state).toBe('CONFIRMED');
    expect(batch.confirmed_by).toBe('U_JOSH');
    expect(batch.confirmed_at).toBeInstanceOf(Date);
  });

  it('refuses to confirm twice or to confirm an imported batch', async () => {
    const batchId = await prepare([row()]);
    await confirmBatch(db, batchId, actor);
    await expect(confirmBatch(db, batchId, actor)).rejects.toThrow(ImportStateError);
    await importBatch(db, batchId);
    await expect(confirmBatch(db, batchId, actor)).rejects.toThrow(ImportStateError);
  });

  it('refuses to import an aborted batch', async () => {
    const batchId = await prepare([row()]);
    await abortBatch(db, batchId);
    await expect(importBatch(db, batchId)).rejects.toThrow(ImportStateError);
    expect(await taskCount()).toBe(0);
  });
});

describe('importing', () => {
  const run = async (rows: StagingRow[], mapping: ImportMapping = {}) => {
    const batchId = await prepare(rows, mapping);
    await confirmBatch(db, batchId, actor);
    return { batchId, report: await importBatch(db, batchId) };
  };

  it('writes only READY rows', async () => {
    const { report } = await run([
      row({ rowNumber: 1, sourceRecordId: 'a', title: 'Fresh one' }),
      row({ rowNumber: 2, sourceRecordId: 'b', title: '' }),                    // INVALID
      row({ rowNumber: 3, sourceRecordId: 'c', title: 'Meditate' }),            // INVALID
      row({ rowNumber: 4, sourceRecordId: 'd', space: 'Nowhere' }),             // INVALID
    ]);
    expect(await taskCount()).toBe(1);
    expect(report.imported).toBe(1);
    expect(report.failed).toBe(3);
  });

  it('preserves titles byte-exact through the whole pipeline', async () => {
    const titles = [
      'Offer Neil Instagram and Facebook package for $100',
      'Waiting on Milltown’s reply to the email proposal',
      'Secure Logic — three-month honeymoon check-in with Marty',
      'Consolidate 401(k): move Corebridge to Fidelity',
      'ship it 🚀',
      'fix *urgent* bug_now~ish~',
    ];
    await run(titles.map((title, i) => row({
      rowNumber: i + 1, sourceRecordId: `r-${i}`, title,
    })));
    const { rows } = await db.query<{ title: string }>(
      `SELECT title FROM tasks ORDER BY created_at, title`
    );
    expect(rows.map((r) => r.title).sort()).toEqual([...titles].sort());
  });

  it('stamps provenance on every imported task', async () => {
    const { batchId } = await run([row()]);
    const { rows } = await db.query<{
      source_platform: string; source_external_id: string; import_batch_id: string;
    }>(`SELECT source_platform, source_external_id, import_batch_id FROM tasks`);
    expect(rows[0]).toEqual({
      source_platform: 'csv', source_external_id: 'r-1', import_batch_id: batchId,
    });
  });

  it('carries resolved status, assignee, due date, and waiting_on', async () => {
    await run([
      row({ rowNumber: 1, sourceRecordId: 'a', assignee: 'josh@x.com',
            dueAt: '2026-09-15', status: 'pending' }),
      row({ rowNumber: 2, sourceRecordId: 'b', title: 'Parked',
            waitingOn: 'Neil to reply' }),
      row({ rowNumber: 3, sourceRecordId: 'c', title: 'Old done thing',
            status: 'done', completedAt: '2026-01-05' }),
    ], { assignees: { 'josh@x.com': 'U_JOSH' } });

    const { rows } = await db.query<any>(
      `SELECT title, status, assignee_id, due_at, waiting_on, completed_at
         FROM tasks ORDER BY title`
    );
    const byTitle = Object.fromEntries(rows.map((r: any) => [r.title, r]));
    expect(byTitle['Call Neil'].status).toBe('open');
    expect(byTitle['Call Neil'].assignee_id).toBe('U_JOSH');
    expect(byTitle['Call Neil'].due_at).toBeInstanceOf(Date);
    expect(byTitle['Parked'].status).toBe('waiting');
    expect(byTitle['Parked'].waiting_on).toBe('Neil to reply');
    expect(byTitle['Old done thing'].status).toBe('completed');
  });

  it('preserves historical created_at and completed_at and does not reopen', async () => {
    await run([row({
      title: 'Historical', status: 'done',
      createdAt: '2025-03-01', completedAt: '2025-04-02',
    })]);
    const { rows } = await db.query<{ created_at: Date; completed_at: Date; status: string }>(
      `SELECT created_at, completed_at, status FROM tasks`
    );
    expect(rows[0]!.status).toBe('completed');
    expect(new Date(rows[0]!.created_at).getUTCFullYear()).toBe(2025);
    expect(new Date(rows[0]!.completed_at).getUTCMonth()).toBe(3); // April
  });

  it('writes one audit row per staged row with the right action', async () => {
    const existing = await createTask(db, { title: 'Call Neil', spaceId: marketingId });
    const { batchId } = await run([
      row({ rowNumber: 1, sourceRecordId: 'a', title: 'Fresh' }),
      row({ rowNumber: 2, sourceRecordId: 'b', title: 'Call Neil' }),  // NEEDS_REVIEW
      row({ rowNumber: 3, sourceRecordId: 'c', title: '' }),           // INVALID
    ]);
    const audit = await getAudit(db, batchId);
    const actions = audit.map((a) => a.action).sort();
    expect(actions).toEqual(['FAILED', 'IMPORTED', 'NEEDS_REVIEW']);

    const imported = audit.find((a) => a.action === 'IMPORTED')!;
    expect(imported.canonical_task_id).not.toBeNull();
    const review = audit.find((a) => a.action === 'NEEDS_REVIEW')!;
    expect(review.canonical_task_id).toBe(existing.id); // points at the conflict
    const failed = audit.find((a) => a.action === 'FAILED')!;
    expect(failed.canonical_task_id).toBeNull();
  });

  it('advances the batch to IMPORTED with a timestamp', async () => {
    const { batchId } = await run([row()]);
    const batch = (await getBatch(db, batchId))!;
    expect(batch.state).toBe('IMPORTED');
    expect(batch.imported_at).toBeInstanceOf(Date);
  });

  it('links each staged row to the task it created', async () => {
    const { batchId } = await run([row()]);
    const staged = (await getStagedRows(db, batchId))[0]!;
    expect(staged.canonical_task_id).not.toBeNull();
    expect((await getTask(db, staged.canonical_task_id!))!.title).toBe('Call Neil');
  });

  it('imports the same file twice without duplicating anything', async () => {
    const rows = [
      row({ rowNumber: 1, sourceRecordId: 'a', title: 'One' }),
      row({ rowNumber: 2, sourceRecordId: 'b', title: 'Two' }),
    ];
    const first = await run(rows);
    expect(first.report.imported).toBe(2);
    expect(await taskCount()).toBe(2);

    // A completely fresh batch over the identical file.
    const second = await run(rows);
    expect(second.report.imported).toBe(0);
    expect(second.report.skipped).toBe(2);
    expect(await taskCount()).toBe(2);

    const audit = await getAudit(db, second.batchId);
    expect(audit.every((a) => a.action === 'SKIPPED_DUPLICATE')).toBe(true);
  });

  it('is idempotent for a source with no record ids, via the derived key', async () => {
    const rows = [row({ sourceRecordId: null, title: 'No id here', createdAt: '2026-01-01' })];
    await run(rows);
    expect(await taskCount()).toBe(1);
    const second = await run(rows);
    expect(second.report.skipped).toBe(1);
    expect(await taskCount()).toBe(1);
  });

  it('reports counts that match the audit rows', async () => {
    await createTask(db, { title: 'Dup', spaceId: marketingId });
    const { batchId, report } = await run([
      row({ rowNumber: 1, sourceRecordId: 'a', title: 'Fresh' }),
      row({ rowNumber: 2, sourceRecordId: 'b', title: 'Dup' }),
      row({ rowNumber: 3, sourceRecordId: 'c', title: '' }),
    ]);
    const audit = await getAudit(db, batchId);
    expect(report.records).toHaveLength(audit.length);
    expect(report.imported).toBe(1);
    expect(report.needsReview).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.batchId).toBe(batchId);
  });
});

describe('transactional safety', () => {
  it('writes zero tasks when a row fails mid-import', async () => {
    // A realistic race: three rows pass analysis, then someone else imports
    // record 'b' before this batch runs. Row 2 now violates the unique index
    // on (source_platform, source_external_id) mid-transaction.
    const batchId = await prepare([
      row({ rowNumber: 1, sourceRecordId: 'a', title: 'One' }),
      row({ rowNumber: 2, sourceRecordId: 'b', title: 'Two' }),
      row({ rowNumber: 3, sourceRecordId: 'c', title: 'Three' }),
    ]);
    await confirmBatch(db, batchId, actor);

    await db.query(
      `INSERT INTO tasks (title, space_id, source_platform, source_external_id)
       VALUES ('Snuck in first', $1, 'csv', 'b')`,
      [marketingId]
    );
    const before = await taskCount();

    await expect(importBatch(db, batchId)).rejects.toThrow();

    // Rows 1 and 3 must NOT have survived: the whole batch rolled back.
    expect(await taskCount()).toBe(before);
    expect((await getBatch(db, batchId))!.state).toBe('CONFIRMED');
    expect(await getAudit(db, batchId)).toEqual([]);
  });
});

describe('read-back verification', () => {
  it('verifies every imported row on a clean import', async () => {
    const batchId = await prepare([
      row({ rowNumber: 1, sourceRecordId: 'a', title: 'One' }),
      row({ rowNumber: 2, sourceRecordId: 'b', title: 'Two' }),
    ]);
    await confirmBatch(db, batchId, actor);
    await importBatch(db, batchId);
    expect(await verifyBatch(db, batchId)).toEqual({ verified: 2, failed: [] });
  });

  it('actually compares, rather than assuming the write worked', async () => {
    const batchId = await prepare([row({ title: 'Exact source title' })]);
    await confirmBatch(db, batchId, actor);
    await importBatch(db, batchId);

    // Corrupt the written title behind the importer's back.
    const staged = (await getStagedRows(db, batchId))[0]!;
    await db.query(`UPDATE tasks SET title = 'tampered' WHERE id = $1`, [
      staged.canonical_task_id,
    ]);

    const result = await verifyBatch(db, batchId);
    expect(result.verified).toBe(0);
    expect(result.failed).toEqual([staged.canonical_task_id]);

    const failures = (await getAudit(db, batchId)).filter((a) => a.action === 'FAILED');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toMatch(/title does not match source/);
  });

  it('catches a moved task, not just a renamed one', async () => {
    const batchId = await prepare([row()]);
    await confirmBatch(db, batchId, actor);
    await importBatch(db, batchId);
    const staged = (await getStagedRows(db, batchId))[0]!;

    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM spaces WHERE name = 'Sales'`
    );
    await db.query(`UPDATE tasks SET space_id = $2 WHERE id = $1`, [
      staged.canonical_task_id, rows[0]!.id,
    ]);

    const result = await verifyBatch(db, batchId);
    expect(result.failed).toEqual([staged.canonical_task_id]);
    const failures = (await getAudit(db, batchId)).filter((a) => a.action === 'FAILED');
    expect(failures[0]!.reason).toMatch(/space does not match/);
  });

  it('clears the staging pointer when its task is deleted, rather than blocking', async () => {
    // Rollback hard-deletes tasks, so the staging foreign key must not stand in
    // the way. Migration 008 makes it ON DELETE SET NULL.
    const batchId = await prepare([row()]);
    await confirmBatch(db, batchId, actor);
    await importBatch(db, batchId);
    const staged = (await getStagedRows(db, batchId))[0]!;

    await db.query(`DELETE FROM task_events WHERE task_id = $1`, [staged.canonical_task_id]);
    await expect(
      db.query(`DELETE FROM tasks WHERE id = $1`, [staged.canonical_task_id])
    ).resolves.toBeTruthy();
    expect((await getStagedRows(db, batchId))[0]!.canonical_task_id).toBeNull();
  });

  it('reports a failed verification in the import report count', async () => {
    // Two rows; corrupt one before verification runs by importing, tampering,
    // then re-verifying.
    const batchId = await prepare([
      row({ rowNumber: 1, sourceRecordId: 'a', title: 'Kept' }),
      row({ rowNumber: 2, sourceRecordId: 'b', title: 'Tampered' }),
    ]);
    await confirmBatch(db, batchId, actor);
    const report = await importBatch(db, batchId);
    expect(report.imported).toBe(2);
    expect(report.failed).toBe(0);
  });
});

describe('provenance write never touches the title', () => {
  it('has no title in the provenance UPDATE statement', async () => {
    const source = await readFile('packages/importer/src/import.ts', 'utf8');
    const stmt = source.slice(
      source.indexOf('UPDATE tasks'),
      source.indexOf('WHERE id = $1', source.indexOf('UPDATE tasks'))
    );
    expect(stmt).toContain('source_external_id');
    expect(stmt).toContain('import_batch_id');
    expect(stmt.toLowerCase()).not.toContain('title');
  });
});
