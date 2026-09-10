import { ImportParseError } from '../errors.js';
import type { Adapter, StagingRow } from '../types.js';

const KNOWN = [
  'source_record_id', 'title', 'space', 'list_state', 'assignee',
  'due_at', 'waiting_on', 'created_at', 'completed_at', 'status',
] as const;

function orNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.length === 0 ? null : value;
}

/** Accepts a top-level array, or an object wrapping one under a known key. */
function recordsFrom(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  if (parsed && typeof parsed === 'object') {
    for (const key of ['tasks', 'records', 'items']) {
      const value = (parsed as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as Record<string, unknown>[];
    }
  }
  throw new ImportParseError(
    'expected a top-level array, or an object with a tasks, records, or items array'
  );
}

export const jsonAdapter: Adapter = (input: string): StagingRow[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    throw new ImportParseError(
      err instanceof Error ? err.message : 'could not parse JSON'
    );
  }

  return recordsFrom(parsed).map((record, index) => {
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!(KNOWN as readonly string[]).includes(key)) extra[key] = value;
    }
    return {
      rowNumber: index + 1,
      sourceType: 'json',
      sourceRecordId: orNull(record.source_record_id),
      // A non-string title stages as empty so analysis marks it INVALID.
      // The adapter never stringifies one — inventing text would be worse than
      // rejecting the row.
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
