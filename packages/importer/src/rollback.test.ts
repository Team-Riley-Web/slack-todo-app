import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask, getTask, completeTask, editTask } from '@tr/task-core';
import { createBatch, stageRows, getBatch, getStagedRows } from './batches.js';
import { applyMapping } from './mapping.js';
import { analyzeBatch } from './analyze.js';
import { confirmBatch, importBatch, getAudit } from './import.js';
import { rollbackBatch } from './rollback.js';
import { ImportStateError } from './errors.js';
import type { StagingRow } from './types.js';

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
  rowNumber: 1, sourceType: 'csv', sourceRecordId: 'r-1', title: 'Imported task',
  space: 'Marketing', listState: null, assignee: null, dueAt: null,
  waitingOn: null, createdAt: null, completedAt: null, status: 'pending',
  sourceMetadata: {}, ...over,
});

const importRows = async (rows: StagingRow[]) => {
  const batchId = await createBatch(db, { sourceType: 'csv', createdBy: 'U_JOSH' });
  await stageRows(db, batchId, rows);
  await applyMapping(db, batchId, {});
  await analyzeBatch(db, batchId);
  await confirmBatch(db, batchId, actor);
  await importBatch(db, batchId);
  return batchId;
};

const taskTitles = async () => {
  const { rows } = await db.query<{ title: string }>(
    `SELECT title FROM tasks ORDER BY title`
  );
  return rows.map((r) => r.title);
};

describe('rollback scope', () => {
  it('deletes only the tasks its own batch created', async () => {
    const batchA = await importRows([
      row({ rowNumber: 1, sourceRecordId: 'a1', title: 'A one' }),
      row({ rowNumber: 2, sourceRecordId: 'a2', title: 'A two' }),
    ]);
    await importRows([row({ sourceRecordId: 'b1', title: 'B one' })]);
    await createTask(db, { title: 'Made in Slack', spaceId: marketingId });

    expect(await taskTitles()).toEqual(['A one', 'A two', 'B one', 'Made in Slack']);

    const result = await rollbackBatch(db, batchA);
    expect(result.deleted).toBe(2);
    expect(result.refused).toBe(0);
    expect(await taskTitles()).toEqual(['B one', 'Made in Slack']);
  });

  it('marks the batch rolled back with a timestamp', async () => {
    const batchId = await importRows([row()]);
    await rollbackBatch(db, batchId);
    const batch = (await getBatch(db, batchId))!;
    expect(batch.state).toBe('ROLLED_BACK');
    expect(batch.rolled_back_at).toBeInstanceOf(Date);
  });

  it('refuses a batch that was never imported', async () => {
    const batchId = await createBatch(db, { sourceType: 'csv' });
    await stageRows(db, batchId, [row()]);
    await expect(rollbackBatch(db, batchId)).rejects.toThrow(ImportStateError);
  });

  it('refuses to roll back twice', async () => {
    const batchId = await importRows([row()]);
    await rollbackBatch(db, batchId);
    await expect(rollbackBatch(db, batchId)).rejects.toThrow(ImportStateError);
  });
});

describe('the edited-since-import guard', () => {
  it('refuses a task whose title was edited after import', async () => {
    const batchId = await importRows([
      row({ rowNumber: 1, sourceRecordId: 'a', title: 'Untouched' }),
      row({ rowNumber: 2, sourceRecordId: 'b', title: 'Edited later' }),
    ]);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM tasks WHERE title = 'Edited later'`
    );
    await editTask(db, rows[0]!.id, { title: 'Edited later, by hand' }, {
      id: 'U_JOSH', source: 'slack',
    });

    const result = await rollbackBatch(db, batchId);
    expect(result.deleted).toBe(1);
    expect(result.refused).toBe(1);
    expect(result.refusedTaskIds).toEqual([rows[0]!.id]);
    expect(await taskTitles()).toEqual(['Edited later, by hand']);
  });

  it('refuses a task that was completed in Slack after import', async () => {
    const batchId = await importRows([row()]);
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM tasks`);
    await completeTask(db, rows[0]!.id, { id: 'U_JOSH', source: 'slack' });

    const result = await rollbackBatch(db, batchId);
    expect(result.deleted).toBe(0);
    expect(result.refused).toBe(1);
    expect(await getTask(db, rows[0]!.id)).not.toBeNull();
  });

  it('does not treat the import own created event as a later edit', async () => {
    const batchId = await importRows([row()]);
    const result = await rollbackBatch(db, batchId);
    expect(result.refused).toBe(0);
    expect(result.deleted).toBe(1);
  });

  it('deletes a refused task when forced', async () => {
    const batchId = await importRows([row()]);
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM tasks`);
    await completeTask(db, rows[0]!.id, { id: 'U_JOSH', source: 'slack' });

    expect((await rollbackBatch(db, batchId, { force: true })).deleted).toBe(1);
    expect(await taskTitles()).toEqual([]);
  });
});

describe('what rollback preserves', () => {
  it('never deletes an import_audit row, and appends ROLLED_BACK', async () => {
    const batchId = await importRows([
      row({ rowNumber: 1, sourceRecordId: 'a', title: 'One' }),
      row({ rowNumber: 2, sourceRecordId: 'b', title: 'Two' }),
    ]);
    const before = await getAudit(db, batchId);
    expect(before.filter((a) => a.action === 'IMPORTED')).toHaveLength(2);

    await rollbackBatch(db, batchId);

    const after = await getAudit(db, batchId);
    expect(after.filter((a) => a.action === 'IMPORTED')).toHaveLength(2);
    expect(after.filter((a) => a.action === 'ROLLED_BACK')).toHaveLength(2);
    expect(after.length).toBe(before.length + 2);
  });

  it('records why a refused task was not deleted', async () => {
    const batchId = await importRows([row()]);
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM tasks`);
    await completeTask(db, rows[0]!.id, { id: 'U_JOSH', source: 'slack' });
    await rollbackBatch(db, batchId);

    const rolled = (await getAudit(db, batchId)).filter((a) => a.action === 'ROLLED_BACK');
    expect(rolled).toHaveLength(1);
    expect(rolled[0]!.reason).toMatch(/refused: task edited since import/);
  });

  it('removes task_events for deleted tasks without orphaning any', async () => {
    const batchId = await importRows([row()]);
    await rollbackBatch(db, batchId);
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM task_events e
        WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = e.task_id)`
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('clears the staging pointer rather than being blocked by it', async () => {
    const batchId = await importRows([row()]);
    await rollbackBatch(db, batchId);
    expect((await getStagedRows(db, batchId))[0]!.canonical_task_id).toBeNull();
  });

  it('leaves a slack_cards row referencing a deleted task harmless', async () => {
    const batchId = await importRows([row()]);
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM tasks`);
    await db.query(
      `INSERT INTO slack_cards (channel_id, message_ts, task_ids, rendered_state)
       VALUES ('C1', '1.1', $1::uuid[], '{}'::jsonb)`,
      [`{${rows[0]!.id}}`]
    );
    await expect(rollbackBatch(db, batchId)).resolves.toBeTruthy();
    const { rows: cards } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM slack_cards`
    );
    expect(cards[0]!.n).toBe(1); // card survives; the renderer skips missing ids
  });
});

describe('transactional safety', () => {
  it('leaves every task intact if the rollback transaction fails', async () => {
    const batchId = await importRows([
      row({ rowNumber: 1, sourceRecordId: 'a', title: 'One' }),
      row({ rowNumber: 2, sourceRecordId: 'b', title: 'Two' }),
    ]);
    // A task_events row pointing at a task in another batch would break the
    // delete; simulate a mid-transaction failure by dropping the audit table
    // the rollback writes to.
    await db.exec(`ALTER TABLE import_audit RENAME TO import_audit_moved;`);
    await expect(rollbackBatch(db, batchId)).rejects.toThrow();
    await db.exec(`ALTER TABLE import_audit_moved RENAME TO import_audit;`);

    expect(await taskTitles()).toEqual(['One', 'Two']);
    expect((await getBatch(db, batchId))!.state).toBe('IMPORTED');
  });
});
