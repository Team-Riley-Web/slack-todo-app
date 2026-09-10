import type { Space } from '@tr/task-core';

/**
 * The Space picker's options, split into Spaces and Clients.
 *
 * Why groups rather than one flat list: `listSpaces` orders by the name as
 * DISPLAYED, so "Client - CFC Skincare" sorts under C. Slack showed the full
 * stored name, which made a correctly sorted list look scrambled — CFC
 * Skincare, Joy Within Birth, Marketing, Milltown Cabinets, Music, Nazareth
 * Law. Every client name interleaved with the internal ones.
 *
 * `option_groups` is a native `static_select` feature, so the fix is Slack's
 * own: clients go in their own group with the prefix stripped from the label,
 * which both reads alphabetically and mirrors the web sidebar's CLIENTS
 * section.
 *
 * The VALUE is untouched — callers decide whether that is an id or the
 * canonical name, and the canonical name is what `findSpaceExact` needs.
 */

const CLIENT_PREFIX = 'Client - ';

export interface SpaceOption {
  text: { type: 'plain_text'; text: string; emoji: true };
  value: string;
}

export interface SpaceOptionGroups {
  groups: Array<{
    label: { type: 'plain_text'; text: string; emoji: true };
    options: SpaceOption[];
  }>;
  /**
   * Every option built, by value.
   *
   * Slack matches `initial_option` by exact equality, so a caller must hand
   * back the SAME object that appears in a group rather than a structural
   * copy. This map is how — the card's initial_options trap taught us the
   * hard way.
   */
  byValue: Map<string, SpaceOption>;
}

const option = (label: string, value: string): SpaceOption => ({
  text: { type: 'plain_text', text: label.slice(0, 75), emoji: true },
  value,
});

export function spaceOptionGroups(
  spaces: Space[],
  valueOf: (space: Space) => string,
  /** An option to place first, e.g. the "none" sentinel on the map modal. */
  leading?: { label: string; value: string }
): SpaceOptionGroups {
  const byValue = new Map<string, SpaceOption>();
  const add = (label: string, value: string): SpaceOption => {
    const o = option(label, value);
    byValue.set(value, o);
    return o;
  };

  const internal: SpaceOption[] = [];
  const clients: SpaceOption[] = [];

  if (leading) internal.push(add(leading.label, leading.value));

  for (const space of spaces) {
    const isClient = space.name.startsWith(CLIENT_PREFIX);
    // The prefix is dropped from a client's label so the group reads
    // alphabetically by the name a person actually says out loud.
    const label = isClient ? space.name.slice(CLIENT_PREFIX.length) : space.name;
    (isClient ? clients : internal).push(add(label, valueOf(space)));
  }

  const groups: SpaceOptionGroups['groups'] = [];
  // A group with no options is not worth sending, and Slack has no reason to
  // accept one.
  if (internal.length > 0) {
    groups.push({ label: { type: 'plain_text', text: 'Spaces', emoji: true }, options: internal });
  }
  if (clients.length > 0) {
    groups.push({ label: { type: 'plain_text', text: 'Clients', emoji: true }, options: clients });
  }

  return { groups, byValue };
}
