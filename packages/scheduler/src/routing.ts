import { matchesSpaceKeys, type Space } from '@tr/task-core';
import type { SchedulerConfig } from './config.js';
import type { FixedBriefing } from './schedule.js';

/** One row of `channel_space_map`: a channel, and the Space it belongs to. */
export interface ChannelMapping {
  channelId: string;
  spaceId: string;
}

/**
 * One weekly post: which Spaces' tasks it carries and where it goes.
 *
 * Every Space belongs to at most one briefing, so no task can appear in two
 * channels' posts. `planBriefings` is the only place that decision is made.
 */
export interface Briefing {
  /**
   * What a person types to run it by hand: `agency`, `personal`, or the
   * Space's slug for a mapped-channel briefing (`joy-within-birth`).
   */
  name: string;
  /**
   * The ledger key. A mapped-channel briefing is keyed by Space id rather
   * than slug, because renaming a Space regenerates its slug and must not
   * make the same week's briefing look undelivered.
   */
  ledgerKey: string;
  kind: FixedBriefing | 'space';
  channelId: string | null;
  spaces: Space[];
  /** The Personal briefing leaves out the Daily Anchors Hermes posts. */
  excludeDailyAnchors: boolean;
  /**
   * The two fixed briefings post "Nothing open" rather than staying silent, so
   * a quiet Monday in #agency-ops means a failure. A client or Finance
   * channel with nothing open gets no post: an empty card every week in every
   * client channel is noise, not attention.
   */
  postWhenEmpty: boolean;
}

export interface UnroutedSpace {
  space: Space;
  reason: string;
}

export interface BriefingPlan {
  briefings: Briefing[];
  /** Spaces whose tasks go in no briefing, and why. Reported, never guessed. */
  unrouted: UnroutedSpace[];
}

/**
 * Decides where every Space's tasks go this week.
 *
 *   1. Inbox, plus the configured Agency Spaces (Agency / Internal, Marketing,
 *      Sales)                                  -> the Agency channel
 *   2. The configured Personal Spaces (Personal, Music, Spiritual)
 *                                              -> the Personal channel
 *   3. Every other Space -- each client, Finances, anything created later --
 *      goes to the ONE channel `channel_space_map` maps it to, in a briefing
 *      of its own.
 *
 * Rule 3 reads the same mapping `/space` and `/map` maintain, which is what
 * makes routing authoritative: nothing here looks at a channel's name. A
 * channel maps to exactly one Space (the table's primary key), so a
 * mapped-channel briefing can never carry two clients.
 *
 * When rule 3 cannot pick exactly one safe channel, the Space is reported as
 * unrouted instead of posted somewhere plausible:
 *   - no channel mapped to it;
 *   - more than one channel mapped to it, since posting to both would put the
 *     same task in two briefings, and picking one would be a guess;
 *   - its channel is the Agency or Personal channel, which would put client
 *     or finance work into exactly the posts it must stay out of.
 */
export function planBriefings(
  spaces: readonly Space[],
  mappings: readonly ChannelMapping[],
  config: SchedulerConfig
): BriefingPlan {
  const agency: Briefing = {
    name: 'agency',
    ledgerKey: 'weekly:agency',
    kind: 'agency',
    channelId: config.agencyChannelId || null,
    spaces: [],
    excludeDailyAnchors: false,
    postWhenEmpty: true,
  };
  const personal: Briefing = {
    name: 'personal',
    ledgerKey: 'weekly:personal',
    kind: 'personal',
    channelId: config.personalChannelId || null,
    spaces: [],
    excludeDailyAnchors: true,
    postWhenEmpty: true,
  };
  const routed: Briefing[] = [];
  const unrouted: UnroutedSpace[] = [];

  const fixedChannels = new Map<string, string>();
  if (agency.channelId) fixedChannels.set(agency.channelId, 'Agency');
  if (personal.channelId) fixedChannels.set(personal.channelId, 'Personal');

  for (const space of spaces) {
    if (space.is_inbox || matchesSpaceKeys(space, config.agencySpaceKeys)) {
      agency.spaces.push(space);
      continue;
    }
    if (matchesSpaceKeys(space, config.personalSpaceKeys)) {
      personal.spaces.push(space);
      continue;
    }

    const channels = [...new Set(
      mappings.filter((m) => m.spaceId === space.id).map((m) => m.channelId)
    )];
    if (channels.length === 0) {
      unrouted.push({ space, reason: 'no Slack channel is mapped to this Space' });
      continue;
    }
    if (channels.length > 1) {
      unrouted.push({
        space,
        reason: `${channels.length} Slack channels are mapped to this Space; ` +
          'map exactly one so its briefing has a single home',
      });
      continue;
    }
    const channelId = channels[0]!;
    const clash = fixedChannels.get(channelId);
    if (clash) {
      unrouted.push({
        space,
        reason: `its mapped channel is the ${clash} briefing channel, ` +
          `which must not carry this Space's tasks`,
      });
      continue;
    }
    routed.push({
      name: space.slug,
      ledgerKey: `weekly:space:${space.id}`,
      kind: 'space',
      channelId,
      spaces: [space],
      excludeDailyAnchors: false,
      postWhenEmpty: false,
    });
  }

  return { briefings: [agency, personal, ...routed], unrouted };
}

/** The briefing a manual run names, or null. Fixed names win over slugs. */
export function findBriefing(plan: BriefingPlan, name: string): Briefing | null {
  const wanted = name.trim().toLowerCase();
  return plan.briefings.find((b) => b.kind !== 'space' && b.name === wanted)
    ?? plan.briefings.find((b) => b.name === wanted)
    ?? null;
}
