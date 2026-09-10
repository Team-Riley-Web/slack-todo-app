import { ImportLimitError } from './errors.js';
import type { ImportSourceType } from './types.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 20_000;

/**
 * Cheap structural sniff, used to catch a file whose extension disagrees with
 * its contents. Never trusted as the only check — the adapter still has to
 * parse it successfully.
 */
export function sniffFormat(input: string): 'csv' | 'json' | 'unknown' {
  const head = input.slice(0, 4096);
  // A NUL byte means this is not text we should be parsing at all.
  if (head.includes('\u0000')) return 'unknown';
  const trimmed = head.replace(/^﻿/, '').trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? '';
  if (firstLine.includes(',')) return 'csv';
  return 'unknown';
}

/**
 * Enforced BEFORE parsing, so a hostile or accidental 500 MB file never reaches
 * a parser and never lands in staging.
 */
export function assertWithinLimits(input: string, sourceType: ImportSourceType): void {
  const bytes = Buffer.byteLength(input, 'utf8');
  if (bytes > MAX_FILE_BYTES) {
    throw new ImportLimitError(
      `file is ${bytes} bytes, over the ${MAX_FILE_BYTES}-byte limit`
    );
  }

  // Newline count is a cheap upper bound on row count and costs one pass.
  let newlines = 0;
  for (let i = 0; i < input.length; i += 1) {
    if (input.charCodeAt(i) === 10) newlines += 1;
  }
  if (newlines > MAX_ROWS) {
    throw new ImportLimitError(`file has over ${MAX_ROWS} rows`);
  }

  const sniffed = sniffFormat(input);
  if (sniffed === 'unknown') {
    throw new ImportLimitError('file does not look like text CSV or JSON');
  }
  const expected = sourceType === 'csv' ? 'csv' : 'json';
  if (sniffed !== expected) {
    throw new ImportLimitError(
      `declared ${sourceType} but the contents look like ${sniffed}`
    );
  }
}

/**
 * Neutralizes spreadsheet formula injection for any future export path.
 * Nothing exports today; this exists so an export added later cannot forget it.
 */
export function sanitizeForCsvExport(cell: string): string {
  return /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
}
