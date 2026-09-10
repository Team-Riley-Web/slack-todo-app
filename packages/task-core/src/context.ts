import type { Db } from '@tr/db';
import type { Space } from './types.js';
import { UnknownSpaceError } from './errors.js';
import { getInboxSpace } from './spaces.js';

const COLS = `id, name, slug, is_inbox`;

export interface ChannelSpace {
  space: Space;
  /** false when the channel has no mapping and Inbox was used as the fallback. */
  mapped: boolean;
  channelName: string | null;
}

/**
 * Slack channel ID -> canonical Space. Configuration/database driven only.
 * Never infers a client from channel text and never guesses.
 */
export async function getSpaceForChannel(
  db: Db, channelId: string | null | undefined
): Promise<ChannelSpace> {
  if (channelId) {
    const { rows } = await db.query<Space & { channel_name: string | null }>(
      `SELECT s.id, s.name, s.slug, s.is_inbox, m.slack_channel_name AS channel_name
         FROM channel_space_map m JOIN spaces s ON s.id = m.space_id
        WHERE m.slack_channel_id = $1`,
      [channelId]
    );
    const row = rows[0];
    if (row) {
      return {
        space: { id: row.id, name: row.name, slug: row.slug, is_inbox: row.is_inbox },
        mapped: true,
        channelName: row.channel_name,
      };
    }
  }
  return { space: await getInboxSpace(db), mapped: false, channelName: null };
}

/**
 * Exact Space resolution for mutation destinations. Three deterministic forms,
 * each an exact match after one fixed normalization — never a substring or
 * fuzzy match:
 *   - canonical name   "Client - Secure Logic"
 *   - slug             "secure-logic"
 *   - name with the "Client - " prefix dropped   "Secure Logic"
 *   - a configured alias from space_aliases         "Personal tasks"
 * Anything else is unresolvable and raises, rather than landing somewhere.
 */
export async function findSpaceExact(db: Db, query: string): Promise<Space | null> {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;

  const { rows } = await db.query<Space>(
    `SELECT ${COLS} FROM spaces
      WHERE lower(name) = $1
         OR lower(slug) = $1
         OR lower(regexp_replace(name, '^Client - ', '')) = $1
      LIMIT 1`,
    [needle]
  );
  if (rows[0]) return rows[0];

  // Canonical names win over aliases, so this runs only on a miss above.
  const { rows: aliased } = await db.query<Space>(
    `SELECT s.id, s.name, s.slug, s.is_inbox
       FROM space_aliases a JOIN spaces s ON s.id = a.space_id
      WHERE a.alias = $1 LIMIT 1`,
    [needle]
  );
  return aliased[0] ?? null;
}

export interface DestinationRequest {
  channelId?: string | null;
  /** Explicit destination. Wins over the channel mapping when present. */
  space?: string | null;
}

export interface Destination {
  space: Space;
  source: 'explicit' | 'channel' | 'inbox';
}

/**
 * Destination precedence: explicit Space > channel mapping > Inbox.
 *
 * An explicit destination that does not resolve throws UnknownSpaceError. It
 * deliberately does NOT fall back to the channel mapping: silently creating a
 * task somewhere other than where the caller said is the failure mode this
 * service exists to prevent.
 */
export async function resolveDestinationSpace(
  db: Db, req: DestinationRequest
): Promise<Destination> {
  const explicit = req.space?.trim();
  if (explicit) {
    const space = await findSpaceExact(db, explicit);
    if (!space) {
      const { rows } = await db.query<{ name: string }>(`SELECT name FROM spaces ORDER BY name`);
      throw new UnknownSpaceError(explicit, rows.map((r) => r.name));
    }
    return { space, source: 'explicit' };
  }

  const fromChannel = await getSpaceForChannel(db, req.channelId);
  return { space: fromChannel.space, source: fromChannel.mapped ? 'channel' : 'inbox' };
}
