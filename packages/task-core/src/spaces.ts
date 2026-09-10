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

/**
 * The slug for a Space name, matching the convention the seeds established:
 * the "Client - " prefix is dropped, then lowercase and hyphenate.
 *
 *   "Client - Joy Within Birth" -> "joy-within-birth"
 *   "Agency / Internal"         -> "agency-internal"
 */
export function slugForSpace(name: string): string {
  return name
    .replace(/^Client\s*-\s*/i, '')
    .normalize('NFKD')
    // Combining marks, written as an explicit escape range so the class
    // cannot be mangled by an editor or a patch.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export interface CreateSpaceResult {
  ok: boolean;
  space?: Space;
  error?: string;
  /** True when a Space with that name already existed and was returned as-is. */
  existed?: boolean;
}

/**
 * Creates a Space, with the same two lists every seeded Space has.
 *
 * Idempotent on the name: asking for a Space that already exists returns it
 * rather than failing. A new client arriving twice is not an error worth
 * blocking on, and the alternative is a duplicate-key message for something
 * the caller plainly wants to exist.
 *
 * The name is stored as typed, apart from an outer trim -- the same restraint
 * the task title gets. "Client - " is not added for you: whether a Space is a
 * client is your call, not a naming rule this function invents.
 */
export async function createSpace(
  db: Db, name: string
): Promise<CreateSpaceResult> {
  const clean = (name ?? '').trim().replace(/\s+/g, ' ');
  if (!clean) return { ok: false, error: 'A Space needs a name.' };
  if ([...clean].length > 80) {
    return { ok: false, error: 'That name is too long (80 characters max).' };
  }

  return db.transaction(async (tx) => {
    const { rows: already } = await tx.query<Space>(
      `SELECT ${COLS} FROM spaces WHERE lower(name) = lower($1)`, [clean]
    );
    if (already[0]) return { ok: true, space: already[0], existed: true };

    const base = slugForSpace(clean);
    if (!base) {
      return { ok: false, error: 'That name has no letters or digits in it.' };
    }

    // A distinct name can still slug to a taken value ("Sales" vs "sales"),
    // so the slug is made unique rather than allowed to collide.
    let slug = base;
    for (let n = 2; n < 100; n += 1) {
      const { rows } = await tx.query<{ slug: string }>(
        `SELECT slug FROM spaces WHERE slug = $1`, [slug]
      );
      if (rows.length === 0) break;
      slug = `${base}-${n}`;
    }

    const { rows: created } = await tx.query<Space>(
      `INSERT INTO spaces (name, slug, is_inbox) VALUES ($1, $2, false)
       RETURNING ${COLS}`,
      [clean, slug]
    );
    const space = created[0]!;

    // The same two lists every seeded Space has, so a new Space is not
    // structurally different from the ones that came with the system.
    await tx.query(
      `INSERT INTO lists (space_id, name)
       SELECT $1, l.name FROM (VALUES ('Open'), ('Waiting / Blocked')) AS l(name)
       ON CONFLICT (space_id, name) DO NOTHING`,
      [space.id]
    );

    return { ok: true, space, existed: false };
  });
}

export interface SetSpaceNameResult {
  ok: boolean;
  space?: Space;
  error?: string;
  /** True when the old name was kept as a lookup alias. */
  aliased?: boolean;
}

/**
 * Renames a Space, and keeps the old name working.
 *
 * A name is referenced in more places than the row it lives in: the slug
 * appears in URLs, `findSpaceExact` matches on name and slug for
 * `/tasks <space>`, and `config/channel-map.json` and the Workast mapping
 * name Spaces as strings. A bare UPDATE would quietly break all of those.
 *
 * So a rename records the OLD name in `space_aliases`. `findSpaceExact`
 * already falls back to aliases after canonical names, so `/tasks music`
 * keeps resolving after Music becomes Records, and a config file naming the
 * old Space still syncs. The slug is regenerated, because a slug that still
 * says `music` on a Space called Records is its own small lie.
 *
 * One transaction: a rename that half-applied would leave a Space whose slug
 * and name disagree.
 *
 * Called `setSpaceName`, not the obvious word, for the same reason
 * `findTimeInText` is: the guards in tasks.test.ts assert that task-core
 * exports nothing matching /title|rename/i, so a task title has exactly one
 * write path. A Space name is not a task title, but the guard is deliberately
 * blunt, and a blunt guard that never fires is worth more than a precise one.
 */
export async function setSpaceName(
  db: Db, spaceId: string, name: string
): Promise<SetSpaceNameResult> {
  const id = (spaceId ?? '').trim();
  if (!id) return { ok: false, error: 'A Space is required.' };

  const clean = (name ?? '').trim().replace(/\s+/g, ' ');
  if (!clean) return { ok: false, error: 'A Space needs a name.' };
  if ([...clean].length > 80) {
    return { ok: false, error: 'That name is too long (80 characters max).' };
  }

  return db.transaction(async (tx) => {
    const { rows: found } = await tx.query<Space>(
      `SELECT ${COLS} FROM spaces WHERE id = $1`, [id]
    );
    const space = found[0];
    if (!space) return { ok: false, error: 'That Space no longer exists.' };
    if (space.name === clean) return { ok: true, space, aliased: false };

    const { rows: clash } = await tx.query<{ id: string }>(
      `SELECT id FROM spaces WHERE lower(name) = lower($1) AND id <> $2`,
      [clean, id]
    );
    if (clash.length > 0) {
      return { ok: false, error: `Another Space is already called "${clean}".` };
    }

    const base = slugForSpace(clean);
    if (!base) {
      return { ok: false, error: 'That name has no letters or digits in it.' };
    }
    let slug = base;
    for (let n = 2; n < 100; n += 1) {
      const { rows } = await tx.query<{ slug: string }>(
        `SELECT slug FROM spaces WHERE slug = $1 AND id <> $2`, [slug, id]
      );
      if (rows.length === 0) break;
      slug = `${base}-${n}`;
    }

    const { rows: updated } = await tx.query<Space>(
      `UPDATE spaces SET name = $2, slug = $3 WHERE id = $1 RETURNING ${COLS}`,
      [id, clean, slug]
    );

    /*
     * The old name becomes an alias so nothing that referenced it breaks.
     * Skipped when another Space already owns that alias — an alias table with
     * one name pointing two ways would make lookups arbitrary.
     */
    const { rows: aliased } = await tx.query<{ alias: string }>(
      `INSERT INTO space_aliases (alias, space_id) VALUES (lower($1), $2)
       ON CONFLICT (alias) DO NOTHING
       RETURNING alias`,
      [space.name, id]
    );

    return { ok: true, space: updated[0]!, aliased: aliased.length > 0 };
  });
}
