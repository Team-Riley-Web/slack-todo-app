import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask, completeTask, moveTask, getTask } from '@tr/task-core';
import { createBatch, stageRows, getStagedRows, getBatch } from './batches.js';
import { applyMapping, resolveDate, unmappedCategories } from './mapping.js';
import { analyzeBatch, getConflicts } from './analyze.js';
import { derivedIdempotencyKey } from './keys.js';
import { isDailyAnchor, DAILY_ANCHORS } from './anchors.js';
import type { StagingRow } from './types.js';

let db: Db;
let marketingId: string;
const actor = { id: 'U_JOSH', source: 'test' };

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

const stage = async (rows: StagingRow[], mapping = {}) => {
  const batchId = await createBatch(db, { sourceType: 'csv', createdBy: 'U_JOSH' });
  await stageRows(db, batchId, rows);
  await applyMapping(db, batchId, mapping);
  return batchId;
};
const verdicts = async (batchId: string) =>
  (await getStagedRows(db, batchId)).map((r) => ({
    row: r.row_number, verdict: r.verdict, reason: r.reason,
  }));

describe('derived idempotency key', () => {
  it('is 64 lowercase hex characters', () => {
    expect(derivedIdempotencyKey(row())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across calls, which is what makes a re-run a no-op', () => {
    expect(derivedIdempotencyKey(row())).toBe(derivedIdempotencyKey(row()));
  });

  it('changes with title, space, source type, or created date', () => {
    const base = derivedIdempotencyKey(row());
    expect(derivedIdempotencyKey(row({ title: 'Other' }))).not.toBe(base);
    expect(derivedIdempotencyKey(row({ space: 'Sales' }))).not.toBe(base);
    expect(derivedIdempotencyKey(row({ sourceType: 'json' }))).not.toBe(base);
    expect(derivedIdempotencyKey(row({ createdAt: '2026-01-01' }))).not.toBe(base);
  });

  it('is never title alone', () => {
    // Same title, different Space, must not collide.
    expect(derivedIdempotencyKey(row({ space: 'Marketing' })))
      .not.toBe(derivedIdempotencyKey(row({ space: 'Sales' })));
  });

  it('cannot be fooled by field boundaries', () => {
    expect(derivedIdempotencyKey(row({ title: 'a', space: 'b' })))
      .not.toBe(derivedIdempotencyKey(row({ title: 'ab', space: '' })));
  });
});

describe('daily anchors', () => {
  it('matches each anchor exactly, case-insensitively, trimmed', () => {
    for (const anchor of DAILY_ANCHORS) {
      expect(isDailyAnchor(anchor)).toBe(true);
      expect(isDailyAnchor(anchor.toUpperCase())).toBe(true);
      expect(isDailyAnchor(`  ${anchor}  `)).toBe(true);
    }
  });

  it('does not match a title that merely contains an anchor word', () => {
    for (const title of [
      'Meditate with Rachael on Tuesday', 'Exercise bike repair',
      'Journal entry for Q3 review', 'Cold Exposure equipment order',
    ]) {
      expect(isDailyAnchor(title)).toBe(false);
    }
  });
});

describe('resolveDate', () => {
  it('resolves an ISO timestamp', () => {
    expect(resolveDate('2026-09-15T05:00:00Z', 'America/Chicago')?.toISOString())
      .toBe('2026-09-15T05:00:00.000Z');
  });

  it('resolves a date with a separate time and zone, as the Workast export has', () => {
    const d = resolveDate('2026-11-13', 'America/Chicago', '09:00:00');
    // 09:00 Chicago in November is CST, UTC-6.
    expect(d?.toISOString()).toBe('2026-11-13T15:00:00.000Z');
  });

  it('resolves a date with no time to midnight in the zone', () => {
    expect(resolveDate('2026-09-15', 'America/Chicago')?.toISOString())
      .toBe('2026-09-15T05:00:00.000Z');
  });

  it('resolves a space-separated timestamp', () => {
    expect(resolveDate('2026-11-13 09:00:00', 'America/Chicago')?.toISOString())
      .toBe('2026-11-13T15:00:00.000Z');
  });

  it('returns null for anything unparseable rather than guessing', () => {
    for (const raw of ['', '   ', 'tomorrow', 'next week', '13/11/2026', 'garbage', null]) {
      expect(resolveDate(raw, 'America/Chicago')).toBeNull();
    }
  });
});

describe('mapping', () => {
  it('maps a source category to a Space and leaves the title untouched', async () => {
    const title = 'Waiting on Milltown’s reply to the email proposal';
    const batchId = await createBatch(db, { sourceType: 'csv' });
    await stageRows(db, batchId, [row({ title, space: 'Team Riley Operations' })]);

    const beforeTitle = (await getStagedRows(db, batchId))[0]!.title;
    await applyMapping(db, batchId, {
      spaces: { 'Team Riley Operations': 'Agency / Internal' },
    });
    const after = (await getStagedRows(db, batchId))[0]!;

    expect(after.title).toBe(beforeTitle);
    expect(after.title).toBe(title); // byte-exact through mapping
    expect(after.resolved_space_id).not.toBeNull();
  });

  it('resolves a Space by canonical name, slug, prefix-free name, or alias', async () => {
    for (const target of [
      'Client - Secure Logic', 'secure-logic', 'Secure Logic',
    ]) {
      const batchId = await stage([row({ space: 'X' })], { spaces: { X: target } });
      expect((await getStagedRows(db, batchId))[0]!.resolved_space_id).not.toBeNull();
    }
    // 'Personal tasks' is a configured alias for the Personal Space.
    const aliased = await stage([row({ space: 'X' })], { spaces: { X: 'Personal tasks' } });
    expect((await getStagedRows(db, aliased))[0]!.resolved_space_id).not.toBeNull();
  });

  it('leaves an unmapped category unresolved rather than guessing', async () => {
    const batchId = await stage([row({ space: 'Some Unknown Client' })]);
    expect((await getStagedRows(db, batchId))[0]!.resolved_space_id).toBeNull();
    expect(await unmappedCategories(db, batchId)).toEqual(['Some Unknown Client']);
  });

  it('applies defaultSpace only to rows with no source space', async () => {
    const batchId = await stage(
      [row({ rowNumber: 1, space: null }), row({ rowNumber: 2, space: 'Marketing' })],
      { defaultSpace: 'Sales' }
    );
    const rows = await getStagedRows(db, batchId);
    expect(rows[0]!.resolved_space_id).not.toBeNull(); // filled from default
    expect(rows[1]!.resolved_space_id).toBe(marketingId); // its own space wins
  });

  it('maps an assignee and leaves an unmapped one null', async () => {
    const batchId = await stage(
      [row({ rowNumber: 1, assignee: 'josh@teamrileyweb.com' }),
       row({ rowNumber: 2, assignee: 'someone@else.com' })],
      { assignees: { 'josh@teamrileyweb.com': 'U_JOSH' } }
    );
    const rows = await getStagedRows(db, batchId);
    expect(rows[0]!.resolved_assignee_id).toBe('U_JOSH');
    expect(rows[1]!.resolved_assignee_id).toBeNull();
  });

  it('maps statuses, honours an explicit waiting flag, and infers nothing from text', async () => {
    const batchId = await stage([
      row({ rowNumber: 1, status: 'pending' }),
      row({ rowNumber: 2, status: 'pending', sourceMetadata: { waiting: true } }),
      row({ rowNumber: 3, status: 'done' }),
      row({ rowNumber: 4, status: 'Backlog Column 3' }),
    ], { statuses: { pending: 'open' } });
    const rows = await getStagedRows(db, batchId);
    expect(rows[0]!.resolved_status).toBe('open');
    expect(rows[1]!.resolved_status).toBe('waiting');
    expect(rows[2]!.resolved_status).toBe('completed');
    expect(rows[3]!.resolved_status).toBeNull(); // unmapped, not assumed open
  });

  it('advances the batch from PARSED to MAPPED', async () => {
    const batchId = await stage([row()]);
    expect((await getBatch(db, batchId))!.state).toBe('MAPPED');
  });

  it('records the mapping on the batch for later review', async () => {
    const mapping = { spaces: { X: 'Marketing' } };
    const batchId = await stage([row({ space: 'X' })], mapping);
    expect((await getBatch(db, batchId))!.mapping).toEqual(mapping);
  });
});

describe('duplicate analysis', () => {
  it('marks a row READY when nothing matches', async () => {
    const batchId = await stage([row()]);
    await analyzeBatch(db, batchId);
    expect(await verdicts(batchId)).toEqual([
      { row: 1, verdict: 'READY', reason: null },
    ]);
  });

  it('skips a source record already imported in an earlier batch', async () => {
    const earlier = await createBatch(db, { sourceType: 'csv' });
    const task = await createTask(db, { title: 'Call Neil', spaceId: marketingId });
    await db.query(
      `INSERT INTO import_audit (batch_id, source_type, source_record_id, canonical_task_id, action)
       VALUES ($1, 'csv', 'r-1', $2, 'IMPORTED')`,
      [earlier, task.id]
    );

    const batchId = await stage([row()]);
    await analyzeBatch(db, batchId);
    const [v] = await verdicts(batchId);
    expect(v!.verdict).toBe('SKIP_DUPLICATE');
    expect(v!.reason).toMatch(/already imported/);
  });

  it('skips a row whose source id is already carried by a task', async () => {
    await db.query(
      `INSERT INTO tasks (title, space_id, source_platform, source_external_id)
       VALUES ('Call Neil', $1, 'csv', 'r-1')`, [marketingId]
    );
    const batchId = await stage([row()]);
    await analyzeBatch(db, batchId);
    const [v] = await verdicts(batchId);
    expect(v!.verdict).toBe('SKIP_DUPLICATE');
    expect(v!.reason).toMatch(/already carries this source id/);
  });

  it('flags an exact title match in the same Space and status for review, never merging it', async () => {
    const existing = await createTask(db, { title: 'Call Neil', spaceId: marketingId });
    const batchId = await stage([row({ sourceRecordId: 'brand-new' })]);
    await analyzeBatch(db, batchId);

    const staged = (await getStagedRows(db, batchId))[0]!;
    expect(staged.verdict).toBe('NEEDS_REVIEW');
    expect(staged.duplicate_task_id).toBe(existing.id);
    // Nothing was merged or written.
    expect((await getTask(db, existing.id))!.title).toBe('Call Neil');
    const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks`);
    expect(rows[0]!.n).toBe(1);
  });

  it('treats the same title in a different Space as READY', async () => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM spaces WHERE name = 'Sales'`
    );
    await createTask(db, { title: 'Call Neil', spaceId: rows[0]!.id });
    const batchId = await stage([row({ sourceRecordId: 'brand-new' })]);
    await analyzeBatch(db, batchId);
    expect((await verdicts(batchId))[0]!.verdict).toBe('READY');
  });

  it('treats the same title with a different active status as READY', async () => {
    const existing = await createTask(db, { title: 'Call Neil', spaceId: marketingId });
    await completeTask(db, existing.id, actor);
    const batchId = await stage([row({ sourceRecordId: 'brand-new' })]);
    await analyzeBatch(db, batchId);
    expect((await verdicts(batchId))[0]!.verdict).toBe('READY');
  });

  it('applies the fixed precedence when a row matches more than one rule', async () => {
    // Same title in the same Space AND already imported: rule 1 wins.
    const existing = await createTask(db, { title: 'Call Neil', spaceId: marketingId });
    const earlier = await createBatch(db, { sourceType: 'csv' });
    await db.query(
      `INSERT INTO import_audit (batch_id, source_type, source_record_id, canonical_task_id, action)
       VALUES ($1, 'csv', 'r-1', $2, 'IMPORTED')`, [earlier, existing.id]
    );
    const batchId = await stage([row()]);
    await analyzeBatch(db, batchId);
    expect((await verdicts(batchId))[0]!.verdict).toBe('SKIP_DUPLICATE');
  });

  it('skips a record duplicated inside the same file', async () => {
    const batchId = await stage([
      row({ rowNumber: 1 }), row({ rowNumber: 2 }),
    ]);
    await analyzeBatch(db, batchId);
    const v = await verdicts(batchId);
    expect(v[0]!.verdict).toBe('READY');
    expect(v[1]!.verdict).toBe('SKIP_DUPLICATE');
    expect(v[1]!.reason).toMatch(/duplicate of row 1 in this file/);
  });

  it('marks an empty title INVALID', async () => {
    const batchId = await stage([row({ title: '   ' })]);
    await analyzeBatch(db, batchId);
    const [v] = await verdicts(batchId);
    expect(v!.verdict).toBe('INVALID');
    expect(v!.reason).toMatch(/title is empty/);
  });

  it('marks an unmapped Space INVALID and names the category', async () => {
    const batchId = await stage([row({ space: 'Some Unknown Client' })]);
    await analyzeBatch(db, batchId);
    const [v] = await verdicts(batchId);
    expect(v!.verdict).toBe('INVALID');
    expect(v!.reason).toMatch(/Some Unknown Client/);
  });

  it('marks an unmapped status INVALID rather than assuming open', async () => {
    const batchId = await stage([row({ status: 'Column 7' })]);
    await analyzeBatch(db, batchId);
    const [v] = await verdicts(batchId);
    expect(v!.verdict).toBe('INVALID');
    expect(v!.reason).toMatch(/Column 7/);
  });

  it('marks each Daily Anchor INVALID so it cannot enter through an import', async () => {
    const batchId = await stage(
      DAILY_ANCHORS.map((title, i) => row({ rowNumber: i + 1, sourceRecordId: `a-${i}`, title }))
    );
    await analyzeBatch(db, batchId);
    const v = await verdicts(batchId);
    expect(v.every((x) => x.verdict === 'INVALID')).toBe(true);
    expect(v.every((x) => /tracked externally/.test(x.reason ?? ''))).toBe(true);
  });

  it('imports a task that merely mentions an anchor word', async () => {
    const batchId = await stage([row({ title: 'Meditate with Rachael on Tuesday' })]);
    await analyzeBatch(db, batchId);
    expect((await verdicts(batchId))[0]!.verdict).toBe('READY');
  });

  it('returns counts that match the staged rows', async () => {
    const batchId = await stage([
      row({ rowNumber: 1, sourceRecordId: 'a' }),
      row({ rowNumber: 2, sourceRecordId: 'b', title: '' }),
      row({ rowNumber: 3, sourceRecordId: 'c', title: 'Meditate' }),
    ]);
    const counts = await analyzeBatch(db, batchId);
    expect(counts).toEqual({ READY: 1, SKIP_DUPLICATE: 0, NEEDS_REVIEW: 0, INVALID: 2 });
  });

  it('is idempotent when run twice', async () => {
    const batchId = await stage([row()]);
    const first = await analyzeBatch(db, batchId);
    const second = await analyzeBatch(db, batchId);
    expect(second).toEqual(first);
    expect(await getStagedRows(db, batchId)).toHaveLength(1);
  });

  it('advances the batch from MAPPED to ANALYZED', async () => {
    const batchId = await stage([row()]);
    await analyzeBatch(db, batchId);
    expect((await getBatch(db, batchId))!.state).toBe('ANALYZED');
  });

  it('reports conflicts as the rows needing a human', async () => {
    const existing = await createTask(db, { title: 'Call Neil', spaceId: marketingId });
    await moveTask(db, existing.id, { status: 'open' }, actor);
    const batchId = await stage([
      row({ rowNumber: 1, sourceRecordId: 'a', title: 'Call Neil' }),
      row({ rowNumber: 2, sourceRecordId: 'b', title: '' }),
      row({ rowNumber: 3, sourceRecordId: 'c', title: 'Something fresh' }),
    ]);
    await analyzeBatch(db, batchId);
    const conflicts = await getConflicts(db, batchId);
    expect(conflicts.map((c) => c.row_number)).toEqual([1, 2]);
  });
});

describe('no fuzzy matching exists in this package', () => {
  it('contains no similarity, distance, or LIKE comparison', async () => {
    const dir = 'packages/importer/src';
    const walk = async (d: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) out.push(...(await walk(p)));
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
      }
      return out;
    };
    const offenders: string[] = [];
    for (const file of await walk(dir)) {
      const raw = await readFile(file, 'utf8');
      // Strip comments first: the prose explaining WHY there is no fuzzy
      // matching would otherwise trip the scan for fuzzy matching.
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      // SQL keywords are uppercase throughout this repo, so match LIKE
      // case-SENSITIVELY: the English word "like" appears in error messages
      // ("the contents look like json") and is not a SQL comparison.
      const sqlLike = /\b(I?LIKE)\b/.test(code);
      const fuzzyFn = /similarity\(|levenshtein|soundex|trigram|\bfuzzy\b/i.test(code);
      if (sqlLike || fuzzyFn) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
