import type { Db } from '@tr/db';
import { UnknownSpaceError } from './errors.js';
import { findSpaceExact } from './context.js';
import type { Space } from './types.js';

export interface ChannelMapEntry {
  /** Human-readable channel name, for operator legibility only. */
  name?: string;
  /** Canonical Space name, slug, or client-prefix-free name. */
  space: string;
}

export type ChannelMapConfig = Record<string, ChannelMapEntry>;

export interface SyncResult {
  upserted: number;
  pruned: number;
  channels: Array<{ channelId: string; channelName: string | null; spaceName: string }>;
}

/**
 * Applies a channel -> Space mapping from configuration to the database.
 *
 * Deterministic and validating: every Space must resolve exactly, and an
 * unresolvable one aborts the whole sync rather than importing a partial
 * mapping. Nothing here is inferred or generated.
 */
export async function syncChannelMap(
  db: Db, config: ChannelMapConfig, opts: { prune?: boolean } = {}
): Promise<SyncResult> {
  const resolved: Array<{ channelId: string; channelName: string | null; spaceId: string; spaceName: string }> = [];

  // Resolve everything before writing anything.
  for (const [channelId, entry] of Object.entries(config)) {
    const space = await findSpaceExact(db, entry.space);
    if (!space) {
      const { rows } = await db.query<{ name: string }>(`SELECT name FROM spaces ORDER BY name`);
      throw new UnknownSpaceError(entry.space, rows.map((r) => r.name));
    }
    resolved.push({
      channelId,
      channelName: entry.name ?? null,
      spaceId: space.id,
      spaceName: space.name,
    });
  }

  for (const r of resolved) {
    await db.query(
      `INSERT INTO channel_space_map (slack_channel_id, slack_channel_name, space_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (slack_channel_id) DO UPDATE
         SET slack_channel_name = EXCLUDED.slack_channel_name,
             space_id = EXCLUDED.space_id`,
      [r.channelId, r.channelName, r.spaceId]
    );
  }

  let pruned = 0;
  if (opts.prune) {
    const keep = resolved.map((r) => r.channelId);
    const { rows } = await db.query<{ slack_channel_id: string }>(
      `DELETE FROM channel_space_map
        WHERE NOT (slack_channel_id = ANY($1)) RETURNING slack_channel_id`,
      [keep.length ? keep : ['']]
    );
    pruned = rows.length;
  }

  return {
    upserted: resolved.length,
    pruned,
    channels: resolved.map(({ channelId, channelName, spaceName }) => ({
      channelId, channelName, spaceName,
    })),
  };
}

export async function listChannelMap(db: Db): Promise<
  Array<{ channelId: string; channelName: string | null; spaceName: string }>
> {
  const { rows } = await db.query<{
    slack_channel_id: string; slack_channel_name: string | null; name: string;
  }>(
    `SELECT m.slack_channel_id, m.slack_channel_name, s.name
       FROM channel_space_map m JOIN spaces s ON s.id = m.space_id
      ORDER BY s.name, m.slack_channel_id`
  );
  return rows.map((r) => ({
    channelId: r.slack_channel_id,
    channelName: r.slack_channel_name,
    spaceName: r.name,
  }));
}

/**
 * Maps one channel to one Space.
 *
 * The single-channel case, for the surfaces that set a mapping interactively:
 * the Slack modal and the web settings page. Both used to reach for
 * `syncChannelMap` with a one-entry object, or -- worse -- their own SQL. This
 * is the one place the rule lives.
 *
 * The Space must already exist. An unknown name throws rather than creating a
 * Space, because Spaces are configuration and a typo in a channel mapping is
 * not an instruction to invent one.
 */
export async function mapChannelToSpace(
  db: Db,
  args: { channelId: string; channelName?: string | null; spaceName: string }
): Promise<Space> {
  const channelId = args.channelId.trim();
  // Not an UnknownSpaceError: nothing is wrong with the Space here.
  if (!channelId) throw new Error('a Slack channel id is required');

  const space = await findSpaceExact(db, args.spaceName);
  if (!space) {
    const { rows } = await db.query<{ name: string }>(
      `SELECT name FROM spaces ORDER BY name`
    );
    throw new UnknownSpaceError(args.spaceName, rows.map((r) => r.name));
  }

  await syncChannelMap(db, {
    [channelId]: {
      name: args.channelName?.trim() || undefined,
      space: args.spaceName,
    },
  });
  return space;
}

/** Removes a mapping. Idempotent: an unmapped channel is not an error. */
export async function unmapChannel(db: Db, channelId: string): Promise<boolean> {
  const id = channelId.trim();
  if (!id) return false;
  const { rows } = await db.query<{ slack_channel_id: string }>(
    `DELETE FROM channel_space_map WHERE slack_channel_id = $1
      RETURNING slack_channel_id`,
    [id]
  );
  return rows.length > 0;
}
