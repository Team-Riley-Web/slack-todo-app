import { parse } from 'csv-parse/sync';
import { ImportParseError } from '../errors.js';
import type { Adapter, StagingRow } from '../types.js';

/**
 * Columns the normalized CSV format understands. Anything else in the file is
 * preserved in `sourceMetadata` rather than dropped, so a provider export can
 * be fed in unmodified and nothing is lost.
 */
const KNOWN = [
  'source_record_id', 'title', 'space', 'list_state', 'assignee',
  'due_at', 'waiting_on', 'created_at', 'completed_at', 'status',
] as const;

/** Empty string means absent. A present-but-empty cell is not data. */
function orNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.length === 0 ? null : value;
}

export const csvAdapter: Adapter = (input: string): StagingRow[] => {
  let records: Record<string, string>[];
  try {
    records = parse(input, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: false,
      bom: true,
    }) as Record<string, string>[];
  } catch (err) {
    throw new ImportParseError(
      err instanceof Error ? err.message : 'could not parse CSV'
    );
  }

  return records.map((record, index) => {
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!(KNOWN as readonly string[]).includes(key)) extra[key] = value;
    }
    return {
      rowNumber: index + 1,
      sourceType: 'csv',
      sourceRecordId: orNull(record.source_record_id),
      // Byte-exact. csv-parse has already removed only the quoting.
      title: typeof record.title === 'string' ? record.title : '',
      space: orNull(record.space),
      listState: orNull(record.list_state),
      assignee: orNull(record.assignee),
      dueAt: orNull(record.due_at),
      waitingOn: orNull(record.waiting_on),
      createdAt: orNull(record.created_at),
      completedAt: orNull(record.completed_at),
      status: orNull(record.status),
      sourceMetadata: extra,
    };
  });
};
