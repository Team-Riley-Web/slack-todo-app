import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { workastAdapter } from './workast.js';
import { ImportParseError } from '../errors.js';
import type { StagingRow } from '../types.js';

/**
 * These run against the REAL export, not a fixture. If the file shape ever
 * changes these fail, which is the point: the adapter's correctness is a claim
 * about that file.
 */
const EXPORT_PATH = 'docs/workast-export-2026-09-09.json';

let raw: string;
let source: any;
let rows: StagingRow[];

beforeAll(async () => {
  raw = await readFile(EXPORT_PATH, 'utf8');
  source = JSON.parse(raw);
  rows = workastAdapter(raw);
});

describe('the real Workast export', () => {
  it('parses every task the file says it has', () => {
    expect(rows).toHaveLength(21);
    expect(rows).toHaveLength(source.task_count);
  });

  it('preserves the Workast task id on every row', () => {
    const expected = Object.values(source.categories)
      .flat()
      .map((t: any) => t.workast_task_id);
    expect(rows.map((r) => r.sourceRecordId).sort()).toEqual([...expected].sort());
    expect(rows.every((r) => typeof r.sourceRecordId === 'string')).toBe(true);
  });

  it('preserves all 21 titles byte-exact', () => {
    const expected = Object.values(source.categories)
      .flat()
      .map((t: any) => t.title);
    expect(rows.map((r) => r.title).sort()).toEqual([...expected].sort());
  });

  it('preserves the titles carrying a curly apostrophe and an em dash', () => {
    const titles = rows.map((r) => r.title);
    expect(titles).toContain('Waiting on Milltown’s reply to the email proposal');
    expect(titles).toContain('Give Rachael access to Marty’s photos');
    expect(titles).toContain('Secure Logic — three-month honeymoon check-in with Marty');
  });

  it('carries the seven source categories through unmapped', () => {
    const categories = [...new Set(rows.map((r) => r.space))].sort();
    expect(categories).toEqual([
      'Agency / Internal',
      'Client - Milltown Cabinets',
      'Client - Nazareth Law',
      'Client - Secure Logic',
      'Marketing',
      'Music',
      'Personal tasks',
    ]);
  });

  it('leaves Music and Personal tasks for the mapping step to resolve', () => {
    // The adapter must not guess: 'Music' is now its own Space and
    // 'Personal tasks' is an alias, but that is configuration, not parsing.
    expect(rows.filter((r) => r.space === 'Music')).toHaveLength(2);
    expect(rows.filter((r) => r.space === 'Personal tasks')).toHaveLength(4);
  });

  it('flags the one waiting task so mapping can resolve it', () => {
    const waiting = rows.filter((r) => r.sourceMetadata.waiting === true);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.title).toBe('Waiting on Milltown’s reply to the email proposal');
    expect(waiting[0]!.waitingOn).toBeNull(); // the export has none
  });

  it('keeps the one due date with its time and timezone', () => {
    const dated = rows.filter((r) => r.dueAt !== null);
    expect(dated).toHaveLength(1);
    expect(dated[0]!.dueAt).toBe('2026-11-13');
    expect(dated[0]!.sourceMetadata.due_time).toBe('09:00:00');
    expect(dated[0]!.sourceMetadata.due_timezone).toBe('America/Chicago');
    expect(dated[0]!.title).toBe('Secure Logic — three-month honeymoon check-in with Marty');
  });

  it('preserves details verbatim, including the longest one', () => {
    const withDetails = rows.filter(
      (r) => typeof r.sourceMetadata.details === 'string'
    );
    expect(withDetails).toHaveLength(21);

    const lengths = withDetails.map((r) => (r.sourceMetadata.details as string).length);
    expect(Math.max(...lengths)).toBe(3224);

    // And byte-exact against the file, not merely present.
    const byId = new Map(
      Object.values(source.categories).flat().map((t: any) => [t.workast_task_id, t.details])
    );
    for (const row of rows) {
      expect(row.sourceMetadata.details).toBe(byId.get(row.sourceRecordId!));
    }
  });

  it('reports the 14 assigned tasks and leaves 7 unassigned as null', () => {
    const assigned = rows.filter((r) => r.assignee !== null);
    expect(assigned).toHaveLength(14);
    expect(assigned.every((r) => r.assignee === 'josh@teamrileyweb.com')).toBe(true);
    expect(rows.filter((r) => r.assignee === null)).toHaveLength(7);
    expect(rows.some((r) => r.assignee === '')).toBe(false);
  });

  it('keeps the Workast url and canonical source id for traceability', () => {
    for (const row of rows) {
      expect(typeof row.sourceMetadata.workast_url).toBe('string');
      expect(typeof row.sourceMetadata.canonical_source_id).toBe('string');
    }
  });

  it('carries every status through as pending', () => {
    expect([...new Set(rows.map((r) => r.status))]).toEqual(['pending']);
  });

  it('reports no creation timestamps, because the export has none', () => {
    // Worth asserting: imported tasks will appear created at import time, which
    // affects stale-task reporting for pre-existing work.
    expect(rows.every((r) => r.createdAt === null)).toBe(true);
    expect(rows.every((r) => r.completedAt === null)).toBe(true);
  });

  it('numbers rows from one with no gaps', () => {
    expect(rows.map((r) => r.rowNumber)).toEqual(
      Array.from({ length: 21 }, (_, i) => i + 1)
    );
  });

  it('tags every row as a workast source', () => {
    expect(rows.every((r) => r.sourceType === 'workast')).toBe(true);
  });
});

describe('other shapes and failures', () => {
  it('accepts a flat array of tasks', () => {
    const out = workastAdapter(JSON.stringify([
      { workast_task_id: 'w-1', title: 'T', category: 'Marketing' },
    ]));
    expect(out[0]!.sourceRecordId).toBe('w-1');
    expect(out[0]!.space).toBe('Marketing');
  });

  it('accepts a tasks array', () => {
    const out = workastAdapter(JSON.stringify({
      tasks: [{ workast_task_id: 'w-1', title: 'T', category: 'Sales' }],
    }));
    expect(out).toHaveLength(1);
  });

  it('throws on invalid JSON and on an unrecognised shape', () => {
    expect(() => workastAdapter('{nope')).toThrow(ImportParseError);
    expect(() => workastAdapter('42')).toThrow(ImportParseError);
    expect(() => workastAdapter(JSON.stringify({ other: {} }))).toThrow(ImportParseError);
  });

  it('throws when a category is not a list', () => {
    expect(() => workastAdapter(JSON.stringify({ categories: { Marketing: 'nope' } })))
      .toThrow(/is not a list/);
  });

  it('stages a missing title as empty rather than inventing one', () => {
    const out = workastAdapter(JSON.stringify({
      categories: { Marketing: [{ workast_task_id: 'w-1' }] },
    }));
    expect(out[0]!.title).toBe('');
  });

  it('makes no network or filesystem call, so the old Workast is untouched', async () => {
    const src = await readFile('packages/importer/src/adapters/workast.ts', 'utf8');
    expect(src).not.toMatch(/\bfetch\b|node:https?|node:fs|axios|request\(/);
  });
});
