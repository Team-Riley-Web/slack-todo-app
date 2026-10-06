import { describe, it, expect } from 'vitest';
import { csvAdapter } from './csv.js';
import { jsonAdapter } from './json.js';
import { ImportParseError, ImportLimitError } from '../errors.js';
import {
  assertWithinLimits, sniffFormat, sanitizeForCsvExport, MAX_ROWS,
} from '../limits.js';

const HEADER =
  'source_record_id,title,space,list_state,assignee,due_at,waiting_on,created_at,completed_at,status';

describe('CSV adapter', () => {
  it('parses a valid file into the right fields', () => {
    const rows = csvAdapter(
      `${HEADER}\nw-1,Call Neil,Marketing,Open,josh@x.com,2026-09-15,,2026-01-01,,pending\n`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rowNumber: 1,
      sourceType: 'csv',
      sourceRecordId: 'w-1',
      title: 'Call Neil',
      space: 'Marketing',
      listState: 'Open',
      assignee: 'josh@x.com',
      dueAt: '2026-09-15',
      waitingOn: null,
      createdAt: '2026-01-01',
      completedAt: null,
      status: 'pending',
    });
  });

  it('keeps titles byte-exact', () => {
    const cases = [
      ['plain', 'Call Neil'],
      ['comma', 'Offer Neil Instagram, Facebook, and TikTok'],
      ['curly apostrophe', 'Waiting on Milltown’s reply to the email proposal'],
      ['em dash', 'Secure Logic — three-month honeymoon check-in with Marty'],
      ['mrkdwn chars', 'fix *urgent* bug_now~ish~'],
      ['inner spaces', 'lots    of     spaces'],
      ['embedded quote', 'he said "no" twice'],
    ] as const;
    for (const [label, title] of cases) {
      const csv = `${HEADER}\nr-1,"${title.replace(/"/g, '""')}",Marketing,,,,,,,\n`;
      expect(csvAdapter(csv)[0]!.title, label).toBe(title);
    }
  });

  it('preserves unknown columns in sourceMetadata', () => {
    const rows = csvAdapter(
      `${HEADER},workast_url,priority\nr-1,T,Marketing,,,,,,,,https://x/y,high\n`
    );
    expect(rows[0]!.sourceMetadata).toEqual({
      workast_url: 'https://x/y', priority: 'high',
    });
  });

  it('turns missing optional values into null, not empty string', () => {
    const rows = csvAdapter(`${HEADER}\n,T,,,,,,,,\n`);
    const r = rows[0]!;
    expect(r.sourceRecordId).toBeNull();
    expect(r.space).toBeNull();
    expect(r.assignee).toBeNull();
    expect(r.dueAt).toBeNull();
    expect(r.status).toBeNull();
  });

  it('stages a row with an empty title rather than rejecting it', () => {
    // The adapter stages; the analyze step decides validity.
    const rows = csvAdapter(`${HEADER}\nr-1,,Marketing,,,,,,,\n`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('');
  });

  it('numbers rows from one', () => {
    const rows = csvAdapter(
      `${HEADER}\nr-1,A,,,,,,,,\nr-2,B,,,,,,,,\nr-3,C,,,,,,,,\n`
    );
    expect(rows.map((r) => r.rowNumber)).toEqual([1, 2, 3]);
  });

  it('throws ImportParseError on malformed CSV and stages nothing', () => {
    expect(() => csvAdapter(`${HEADER}\nr-1,"unterminated,Marketing\n`))
      .toThrow(ImportParseError);
    expect(() => csvAdapter(`${HEADER}\nr-1,too,many,columns,here,now,and,more,and,more,extra\n`))
      .toThrow(ImportParseError);
  });

  it('handles a BOM without corrupting the first header', () => {
    const rows = csvAdapter(`﻿${HEADER}\nr-1,T,Marketing,,,,,,,\n`);
    expect(rows[0]!.sourceRecordId).toBe('r-1');
  });
});

describe('JSON adapter', () => {
  const row = {
    source_record_id: 'w-1', title: 'Call Neil', space: 'Marketing',
    status: 'pending', assignee: 'josh@x.com',
  };

  it('parses a top-level array', () => {
    const rows = jsonAdapter(JSON.stringify([row]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Call Neil');
    expect(rows[0]!.sourceType).toBe('json');
  });

  it('parses a wrapped array under tasks, records, or items', () => {
    for (const key of ['tasks', 'records', 'items']) {
      expect(jsonAdapter(JSON.stringify({ [key]: [row] }))).toHaveLength(1);
    }
  });

  it('keeps titles byte-exact', () => {
    for (const title of [
      'Waiting on Milltown’s reply to the email proposal',
      'Secure Logic — three-month honeymoon check-in with Marty',
      'ship it 🚀',
      'fix *urgent* bug',
    ]) {
      expect(jsonAdapter(JSON.stringify([{ ...row, title }]))[0]!.title).toBe(title);
    }
  });

  it('stages a non-string title as empty rather than stringifying it', () => {
    for (const title of [42, null, {}, [], true]) {
      expect(jsonAdapter(JSON.stringify([{ ...row, title }]))[0]!.title).toBe('');
    }
  });

  it('preserves unknown keys in sourceMetadata', () => {
    const rows = jsonAdapter(JSON.stringify([{ ...row, details: 'long notes', tags: ['a'] }]));
    expect(rows[0]!.sourceMetadata).toEqual({ details: 'long notes', tags: ['a'] });
  });

  it('throws on invalid JSON and on an unexpected shape', () => {
    expect(() => jsonAdapter('{not json')).toThrow(ImportParseError);
    expect(() => jsonAdapter('42')).toThrow(ImportParseError);
    expect(() => jsonAdapter('"a string"')).toThrow(ImportParseError);
    expect(() => jsonAdapter(JSON.stringify({ nope: [] }))).toThrow(ImportParseError);
  });
});

describe('sniffFormat', () => {
  it('recognizes JSON regardless of leading whitespace or BOM', () => {
    expect(sniffFormat('{"a":1}')).toBe('json');
    expect(sniffFormat('   \n [1,2]')).toBe('json');
    expect(sniffFormat('﻿{"a":1}')).toBe('json');
  });

  it('recognizes CSV by a comma in the first line', () => {
    expect(sniffFormat('a,b,c\n1,2,3')).toBe('csv');
  });

  it('rejects content with a NUL byte as not text', () => {
    expect(sniffFormat('a,b\u0000c')).toBe('unknown');
  });

  it('returns unknown for a single column with no comma', () => {
    expect(sniffFormat('just one line')).toBe('unknown');
  });
});

describe('limits', () => {
  it('accepts a small well-formed file', () => {
    expect(() => assertWithinLimits(`${HEADER}\nr-1,T,,,,,,,,\n`, 'csv')).not.toThrow();
    expect(() => assertWithinLimits('[]', 'json')).not.toThrow();
  });

  it('rejects a file over the row limit before parsing it', () => {
    const huge = `${HEADER}\n${'r,T,,,,,,,,\n'.repeat(MAX_ROWS + 100)}`;
    expect(() => assertWithinLimits(huge, 'csv')).toThrow(/over .* rows/);
  });

  it('rejects a file over the byte limit', () => {
    const big = `a,b\n${'x'.repeat(11 * 1024 * 1024)}`;
    expect(() => assertWithinLimits(big, 'csv')).toThrow(/byte limit/);
  });

  it('rejects a declared csv whose contents are json', () => {
    expect(() => assertWithinLimits('[{"title":"T"}]', 'csv'))
      .toThrow(/declared csv but the contents look like json/);
  });

  it('rejects a declared json whose contents are csv', () => {
    expect(() => assertWithinLimits('a,b\n1,2', 'json'))
      .toThrow(/declared json but the contents look like csv/);
  });

  it('rejects binary-looking content outright', () => {
    expect(() => assertWithinLimits('\u0000binary', 'csv')).toThrow(ImportLimitError);
  });

  it('treats kanban as a json source', () => {
    expect(() => assertWithinLimits('{"tasks":[]}', 'kanban')).not.toThrow();
  });
});

describe('sanitizeForCsvExport', () => {
  it('neutralizes formula-injection prefixes', () => {
    for (const cell of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) {
      expect(sanitizeForCsvExport(cell)).toBe(`'${cell}`);
    }
  });

  it('leaves ordinary values alone', () => {
    for (const cell of ['Call Neil', '2026-09-15', 'Milltown’s reply', '']) {
      expect(sanitizeForCsvExport(cell)).toBe(cell);
    }
  });
});
