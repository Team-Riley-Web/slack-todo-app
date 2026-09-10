import { createHash } from 'node:crypto';
import type { StagingRow } from './types.js';

/**
 * Separator that cannot occur in any source field, so two different field
 * splits can never hash to the same key. A printable separator would let
 * ("a|b", "c") and ("a", "b|c") collide.
 */
const SEP = '\u0000';

/**
 * Fallback idempotency key, used only when a source provides no record id.
 *
 * Deterministic and stable across re-runs of the same file, which is what makes
 * a second import of the same export a no-op. Deliberately NOT title alone:
 * that would collapse two genuinely different tasks that happen to share a
 * title, which is the exact mistake this importer exists to avoid.
 */
export function derivedIdempotencyKey(row: StagingRow): string {
  return createHash('sha256')
    .update([
      row.sourceType,
      row.title,
      row.space ?? '',
      row.createdAt ?? '',
    ].join(SEP))
    .digest('hex');
}

/** The record id when the source has one, otherwise the derived key. */
export function idempotencyKeyFor(row: StagingRow): string {
  return row.sourceRecordId ?? derivedIdempotencyKey(row);
}
