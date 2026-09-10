import type { Db } from '@tr/db';
import type { Space } from './types.js';

const COLS = `id, name, slug, is_inbox`;

/**
 * Every Space, Inbox first, then alphabetical by the name as DISPLAYED.
 *
 * Sorting by the canonical name looked broken: every Space is stored as
 * "Client - Yoga Farm" but shown as "Yoga Farm", so the whole client block
 * sorted under C and landed between "Agency / Internal" and "Marketing". The
 * sort key has to match the text on screen.
 *
 * Inbox stays pinned first rather than sorting into the I's: it is the
 * fallback every unmapped capture lands in, so it is not just another Space in
 * the list.
 */
export async function listSpaces(db: Db): Promise<Space[]> {
  const { rows } = await db.query<Space>(
    `SELECT ${COLS} FROM spaces
      ORDER BY is_inbox DESC, regexp_replace(name, '^Client - ', '')`
  );
  return rows;
}

export interface DeleteSpaceResult {
  ok: boolean;
  error?: string;
  /** What else was removed along with it, for the confirmation message. */
  removed?: { lists: number; channelMappings: number; aliases: number };
}

/**
 * Deletes a Space, but only when nothing would be orphaned.
 *
 * Five tables reference `spaces` and none of them cascade, so a naive delete
 * fails on a foreign key with an opaque message. This decides deliberately
 * what may go and what may not:
 *
 *   tasks           REFUSE. A task is the point of the system, and completed
 *                   ones are history. Move them first.
 *   Inbox           REFUSE. Every unmapped capture falls back to it.
 *   lists           removed. Structure belonging to the Space.
 *   channel map     removed. A mapping to a Space that no longer exists is
 *                   worse than no mapping: captures would fail rather than
 *                   fall back to Inbox.
 *   space_aliases   removed. Same reasoning.
 *   import_staging  pointer cleared. `resolved_space_id` is derived; the
 *                   source `space` text stays, so the record of what was
 *                   submitted survives.
 *
 * One transaction, so a refusal partway leaves nothing half-deleted.
 */
export async function deleteSpace(
  db: Db, spaceId: string
): Promise<DeleteSpaceResult> {
  const id = (spaceId ?? '').trim();
  if (!id) return { ok: false, error: 'A Space is required.' };

  return db.transaction(async (tx) => {
    const { rows: found } = await tx.query<Space>(
      `SELECT ${COLS} FROM spaces WHERE id = $1`, [id]
    );
    const space = found[0];
    if (!space) return { ok: false, error: 'That Space no longer exists.' };

    if (space.is_inbox) {
      return {
        ok: false,
        error: 'Inbox cannot be deleted — every unmapped task falls back to it.',
      };
    }

    const { rows: counts } = await tx.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM tasks WHERE space_id = $1`, [id]
    );
    const taskCount = counts[0]?.n ?? 0;
    if (taskCount > 0) {
      return {
        ok: false,
        error:
          `${space.name} still holds ${taskCount} task${taskCount === 1 ? '' : 's'} ` +
          '(including completed ones). Move or delete them first.',
      };
    }

    await tx.query(
      `UPDATE import_staging SET resolved_space_id = NULL WHERE resolved_space_id = $1`,
      [id]
    );
    const removed = {
      lists: await deleteFrom(tx, 'lists', 'space_id', id),
      channelMappings: await deleteFrom(tx, 'channel_space_map', 'space_id', id),
      aliases: await deleteFrom(tx, 'space_aliases', 'space_id', id),
    };
    await tx.query(`DELETE FROM spaces WHERE id = $1`, [id]);

    return { ok: true, removed };
  });
}

async function deleteFrom(
  tx: Db, table: string, column: string, id: string
): Promise<number> {
  // Table and column are literals from this file, never caller input.
  const { rows } = await tx.query<{ count: string }>(
    `WITH gone AS (DELETE FROM ${table} WHERE ${column} = $1 RETURNING 1)
     SELECT COUNT(*)::text AS count FROM gone`,
    [id]
  );
  return Number(rows[0]?.count ?? 0);
}

export async function getInboxSpace(db: Db): Promise<Space> {
  const { rows } = await db.query<Space>(
    `SELECT ${COLS} FROM spaces WHERE is_inbox = true LIMIT 1`
  );
  const inbox = rows[0];
  if (!inbox) throw new Error('No Inbox space seeded; run migrations');
  return inbox;
}

/** Deterministic: channel mapping only. Never infers a space from message text. */
export async function resolveSpaceForChannel(db: Db, channelId: string): Promise<Space> {
  const { rows } = await db.query<Space>(
    `SELECT s.id, s.name, s.slug, s.is_inbox
       FROM channel_space_map m JOIN spaces s ON s.id = m.space_id
      WHERE m.slack_channel_id = $1`,
    [channelId]
  );
  return rows[0] ?? getInboxSpace(db);
}

/** `%`, `_`, and `\\` are LIKE metacharacters; a raw scope of "%" matched every space. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Read-path convenience for `/tasks agency`. Exact slug or name first, then a
 * substring match. Never used to resolve a mutation target — mutations take UUIDs.
 */
export async function findSpaceByQuery(db: Db, q: string): Promise<Space | null> {
  const needle = q.trim().toLowerCase();
  if (!needle) return null;
  const { rows } = await db.query<Space>(
    `SELECT ${COLS} FROM spaces
      WHERE lower(slug) = $1 OR lower(name) = $1
      LIMIT 1`,
    [needle]
  );
  if (rows[0]) return rows[0];
  const { rows: fuzzy } = await db.query<Space>(
    `SELECT ${COLS} FROM spaces
      WHERE lower(name) LIKE '%' || $1 || '%' ESCAPE '\\'
         OR lower(slug) LIKE '%' || $1 || '%' ESCAPE '\\'
      ORDER BY length(name) LIMIT 2`,
    [escapeLike(needle)]
  );
  return fuzzy[0] ?? null;
}
