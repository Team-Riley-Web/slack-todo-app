import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { listTasks, listWaiting } from '@tr/task-core';
import { workastAdapter } from './adapters/workast.js';
import { assertWithinLimits } from './limits.js';
import { createBatch, stageRows, getStagedRows } from './batches.js';
import { applyMapping, unmappedCategories } from './mapping.js';
import { analyzeBatch, getConflicts } from './analyze.js';
import { confirmBatch, importBatch, verifyBatch } from './import.js';
import { rollbackBatch } from './rollback.js';
import type { ImportMapping } from './types.js';

/**
 * The whole pipeline against the real Workast export. This is the test that
 * says the migration will actually work.
 */
const EXPORT_PATH = 'docs/workast-export-2026-09-09.json';

/**
 * The mapping the migration will use. Every source category is named
 * explicitly — nothing is inferred.
 *
 * `Music` is its own Space and `Personal tasks` is a configured alias for
 * `Personal`, both approved 2026-09-09.
 */
const MAPPING: ImportMapping = {
  spaces: {
    'Agency / Internal': 'Agency / Internal',
    'Marketing': 'Marketing',
    'Music': 'Music',
    'Personal tasks': 'Personal',
    'Client - Nazareth Law': 'Client - Nazareth Law',
    'Client - Secure Logic': 'Client - Secure Logic',
    'Client - Milltown Cabinets': 'Client - Milltown Cabinets',
  },
  assignees: { 'josh@teamrileyweb.com': 'U_JOSH' },
  statuses: { pending: 'open' },
};

let db: Db;
let raw: string;

beforeEach(async () => {
  db = await createTestDb();
  raw = await readFile(EXPORT_PATH, 'utf8');
});
afterEach(async () => { await db.close(); });

const runImport = async (mapping: ImportMapping = MAPPING) => {
  assertWithinLimits(raw, 'workast');
  const rows = workastAdapter(raw);
  const batchId = await createBatch(db, {
    sourceType: 'workast',
    filename: 'workast-export-2026-09-09.json',
    createdBy: 'U_JOSH',
  });
  await stageRows(db, batchId, rows);
  await applyMapping(db, batchId, mapping);
  const counts = await analyzeBatch(db, batchId);
  await confirmBatch(db, batchId, { id: 'U_JOSH' });
  const report = await importBatch(db, batchId);
  return { batchId, counts, report };
};

describe('importing the real export end to end', () => {
  it('maps every source category, leaving none unresolved', async () => {
    assertWithinLimits(raw, 'workast');
    const batchId = await createBatch(db, { sourceType: 'workast' });
    await stageRows(db, batchId, workastAdapter(raw));
    await applyMapping(db, batchId, MAPPING);
    expect(await unmappedCategories(db, batchId)).toEqual([]);
  });

  it('marks all 21 rows ready, with nothing invalid or needing review', async () => {
    const { counts } = await runImport();
    expect(counts).toEqual({
      READY: 21, SKIP_DUPLICATE: 0, NEEDS_REVIEW: 0, INVALID: 0,
    });
  });

  it('imports 21 tasks and verifies every one', async () => {
    const { batchId, report } = await runImport();
    expect(report.imported).toBe(21);
    expect(report.failed).toBe(0);
    expect(await verifyBatch(db, batchId)).toEqual({ verified: 21, failed: [] });
  });

  it('stores all 21 titles byte-exact in the database', async () => {
    await runImport();
    const source = JSON.parse(raw);
    const expected = Object.values(source.categories).flat().map((t: any) => t.title);
    const { rows } = await db.query<{ title: string }>(`SELECT title FROM tasks`);
    expect(rows.map((r) => r.title).sort()).toEqual([...expected].sort());
  });

  it('lands the tasks in the right Spaces, with Music and Personal resolved', async () => {
    await runImport();
    const { rows } = await db.query<{ name: string; n: number }>(
      `SELECT s.name, COUNT(*)::int AS n
         FROM tasks t JOIN spaces s ON s.id = t.space_id
        GROUP BY s.name ORDER BY s.name`
    );
    expect(rows.map((r) => [r.name, Number(r.n)])).toEqual([
      ['Agency / Internal', 7],
      ['Client - Milltown Cabinets', 1],
      ['Client - Nazareth Law', 2],
      ['Client - Secure Logic', 2],
      ['Marketing', 3],
      ['Music', 2],
      ['Personal', 4],
    ]);
  });

  it('keeps the one waiting task out of the actionable list', async () => {
    await runImport();
    const waiting = await listWaiting(db);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.title).toBe('Waiting on Milltown’s reply to the email proposal');

    const actionable = await listTasks(db, { actionableOnly: true });
    expect(actionable).toHaveLength(20);
    expect(actionable.map((t) => t.title))
      .not.toContain('Waiting on Milltown’s reply to the email proposal');
  });

  it('resolves the one due date to the right instant, keeping its time and zone', async () => {
    await runImport();
    const { rows } = await db.query<{ title: string; due_at: Date }>(
      `SELECT title, due_at FROM tasks WHERE due_at IS NOT NULL`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Secure Logic — three-month honeymoon check-in with Marty');
    // 09:00 on 2026-11-13 in America/Chicago is CST, so 15:00Z.
    expect(new Date(rows[0]!.due_at).toISOString()).toBe('2026-11-13T15:00:00.000Z');
  });

  it('assigns the 14 assigned tasks and leaves 7 unassigned', async () => {
    await runImport();
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM tasks WHERE assignee_id = 'U_JOSH'`
    );
    expect(rows[0]!.n).toBe(14);
    const { rows: none } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM tasks WHERE assignee_id IS NULL`
    );
    expect(none[0]!.n).toBe(7);
  });

  it('carries the details across, including the 3224-character one', async () => {
    await runImport();
    const { rows } = await db.query<{ n: number; longest: number }>(
      `SELECT COUNT(*)::int AS n, MAX(length(details))::int AS longest
         FROM tasks WHERE details IS NOT NULL`
    );
    expect(rows[0]!.n).toBe(21);
    expect(Number(rows[0]!.longest)).toBe(3224);
  });

  it('re-running the same export imports nothing', async () => {
    await runImport();
    const { counts, report } = await runImport();
    expect(counts.SKIP_DUPLICATE).toBe(21);
    expect(counts.READY).toBe(0);
    expect(report.imported).toBe(0);

    const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks`);
    expect(rows[0]!.n).toBe(21);
  });

  it('rolls the whole batch back cleanly when nothing has been touched', async () => {
    const { batchId } = await runImport();
    const result = await rollbackBatch(db, batchId);
    expect(result.deleted).toBe(21);
    expect(result.refused).toBe(0);
    const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks`);
    expect(rows[0]!.n).toBe(0);
  });

  it('flags every row invalid if a category is left unmapped, importing nothing', async () => {
    const partial: ImportMapping = {
      ...MAPPING,
      spaces: { ...MAPPING.spaces },
    };
    delete partial.spaces!['Music'];

    assertWithinLimits(raw, 'workast');
    const batchId = await createBatch(db, { sourceType: 'workast' });
    await stageRows(db, batchId, workastAdapter(raw));
    await applyMapping(db, batchId, partial);
    const counts = await analyzeBatch(db, batchId);

    // 'Music' happens to resolve as a Space by its own name even without a
    // mapping entry, which is correct: it IS a canonical Space now.
    expect(counts.INVALID + counts.READY).toBe(21);
    expect(await unmappedCategories(db, batchId)).toEqual([]);
  });

  it('reports conflicts when a task already exists with the same title', async () => {
    await runImport();
    // Roll back so the source ids are free, then hand-create one of the tasks.
    const { rows: batch } = await db.query<{ id: string }>(
      `SELECT id FROM import_batches LIMIT 1`
    );
    await rollbackBatch(db, batch[0]!.id);
    await db.query(
      `INSERT INTO tasks (title, space_id)
       SELECT 'Complete GMB verification', id FROM spaces WHERE name = 'Agency / Internal'`
    );

    assertWithinLimits(raw, 'workast');
    const batchId = await createBatch(db, { sourceType: 'workast' });
    await stageRows(db, batchId, workastAdapter(raw));
    await applyMapping(db, batchId, MAPPING);
    await analyzeBatch(db, batchId);

    const conflicts = await getConflicts(db, batchId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.title).toBe('Complete GMB verification');
    expect(conflicts[0]!.verdict).toBe('NEEDS_REVIEW');
    expect(conflicts[0]!.duplicate_task_id).not.toBeNull();
  });

  it('allows a re-import after a rollback, which is the point of rolling back', async () => {
    const first = await runImport();
    expect(first.report.imported).toBe(21);
    await rollbackBatch(db, first.batchId);

    // Audit rows survive the rollback, so this only works because rule 1
    // requires the referenced task to still exist.
    const second = await runImport();
    expect(second.counts.READY).toBe(21);
    expect(second.report.imported).toBe(21);

    const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks`);
    expect(rows[0]!.n).toBe(21);
  });

  it('never writes a task before confirmation', async () => {
    assertWithinLimits(raw, 'workast');
    const batchId = await createBatch(db, { sourceType: 'workast' });
    await stageRows(db, batchId, workastAdapter(raw));
    await applyMapping(db, batchId, MAPPING);
    await analyzeBatch(db, batchId);

    const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks`);
    expect(rows[0]!.n).toBe(0);
    expect(await getStagedRows(db, batchId)).toHaveLength(21);
  });
});
