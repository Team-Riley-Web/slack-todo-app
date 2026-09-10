import type { Db } from '@tr/db';
import type { Space } from './types.js';

const COLS = `id, name, slug, is_inbox`;

export async function listSpaces(db: Db): Promise<Space[]> {
  const { rows } = await db.query<Space>(
    `SELECT ${COLS} FROM spaces ORDER BY is_inbox DESC, name`
  );
  return rows;
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
      WHERE lower(name) LIKE '%' || $1 || '%' OR lower(slug) LIKE '%' || $1 || '%'
      ORDER BY length(name) LIMIT 2`,
    [needle]
  );
  return fuzzy[0] ?? null;
}
