import type { Db } from '@tr/db';
import { listSpaces, matchesSpaceKeys, type Space } from '@tr/task-core';
import type { SchedulerConfig } from './config.js';
import type { ChannelMapping } from './routing.js';

export interface SlackChannel {
  id: string;
  name: string;
}

/** The slice of Slack's `conversations.list` this needs. */
export interface ChannelLister {
  conversations: {
    list: (args: Record<string, unknown>) => Promise<{
      channels?: Array<{ id?: string; name?: string; is_archived?: boolean }>;
      response_metadata?: { next_cursor?: string };
    }>;
  };
}

export interface NewMapping {
  channelId: string;
  channelName: string;
  space: Space;
}

/**
 * The Space a channel NAME points at, or null.
 *
 * Deliberately narrow: the channel is called exactly the Space's slug
 * (`#joy-within-birth`) or the slug with a `client-` prefix
 * (`#client-joy-within-birth`). Anything fuzzier -- a substring, a
 * `-ops` suffix -- is a guess, and a wrong guess puts one client's tasks in
 * another client's channel.
 */
export function matchSpace(channelName: string, spaces: readonly Space[]): Space | null {
  const name = channelName.trim().toLowerCase().replace(/^#/, '');
  const hits = spaces.filter((s) => {
    const slug = s.slug.toLowerCase();
    return name === slug || name === `client-${slug}`;
  });
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * Which unmapped channels should be mapped, and to what.
 *
 * Only fills gaps. A channel that already has a mapping is never touched, so
 * nothing a person set with `/space` or `/map` is overwritten. A Space that
 * already has a channel is not given a second one (that would make it
 * unroutable), and the Agency and Personal Spaces keep their fixed channels.
 * If two new channels match the same Space, the first by name wins and the
 * other is left for a person to decide.
 */
export function planChannelMappings(
  channels: readonly SlackChannel[],
  spaces: readonly Space[],
  existing: readonly ChannelMapping[],
  config: SchedulerConfig
): NewMapping[] {
  const fixed = new Set([config.agencyChannelId, config.personalChannelId].filter(Boolean));
  const mappedChannels = new Set(existing.map((m) => m.channelId));
  const takenSpaces = new Set(existing.map((m) => m.spaceId));

  const eligible = spaces.filter((s) =>
    !s.is_inbox
    && !matchesSpaceKeys(s, config.agencySpaceKeys)
    && !matchesSpaceKeys(s, config.personalSpaceKeys)
  );

  const out: NewMapping[] = [];
  for (const ch of [...channels].sort((a, b) => a.name.localeCompare(b.name))) {
    if (fixed.has(ch.id) || mappedChannels.has(ch.id)) continue;
    const space = matchSpace(ch.name, eligible.filter((s) => !takenSpaces.has(s.id)));
    if (!space) continue;
    takenSpaces.add(space.id);
    out.push({ channelId: ch.id, channelName: ch.name, space });
  }
  return out;
}

/** Every non-archived public and private channel the bot can see. */
export async function listSlackChannels(client: ChannelLister): Promise<SlackChannel[]> {
  const out: SlackChannel[] = [];
  let cursor: string | undefined;
  do {
    const res = await client.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    for (const c of res.channels ?? []) {
      if (c.id && c.name && !c.is_archived) out.push({ id: c.id, name: c.name });
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}

/**
 * Maps new channels to the Spaces their names point at, writing the same
 * `channel_space_map` rows `/space` and `/map` write -- so routing still reads
 * only that table. With `apply: false` it reports what it would do and writes
 * nothing.
 */
export async function syncChannelMappings(
  db: Db, client: ChannelLister, config: SchedulerConfig, opts: { apply: boolean }
): Promise<NewMapping[]> {
  const [channels, spaces, { rows }] = await Promise.all([
    listSlackChannels(client),
    listSpaces(db),
    db.query<{ slack_channel_id: string; space_id: string }>(
      `SELECT slack_channel_id, space_id FROM channel_space_map`
    ),
  ]);
  const planned = planChannelMappings(
    channels, spaces,
    rows.map((r) => ({ channelId: r.slack_channel_id, spaceId: r.space_id })),
    config
  );
  if (opts.apply) {
    for (const m of planned) {
      await db.query(
        `INSERT INTO channel_space_map (slack_channel_id, slack_channel_name, space_id)
         VALUES ($1, $2, $3) ON CONFLICT (slack_channel_id) DO NOTHING`,
        [m.channelId, m.channelName, m.space.id]
      );
    }
  }
  return planned;
}
