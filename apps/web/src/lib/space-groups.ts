import type { Space } from '@tr/task-core';
import { isClientSpace, shortSpaceName } from '@/lib/display';

/**
 * A Space picker's contents, split into Spaces and Clients.
 *
 * The same fix the Slack pickers got, for the same reason. `listSpaces`
 * orders by the name as DISPLAYED, so "Client - CFC Skincare" sorts under C.
 * A select showing the full stored name therefore made a correctly sorted
 * list look scrambled: Agency, Client - CFC Skincare, Finances, Client - Joy
 * Within Birth, Marketing, Client - Milltown Cabinets, Music... every client
 * interleaved with the internal ones and every one of them shouting the same
 * redundant prefix.
 *
 * Clients go in their own group with the prefix stripped, which reads
 * alphabetically and mirrors the sidebar's CLIENTS section. `optgroup` is
 * native HTML, so this needs no JavaScript, exactly like Slack's
 * `option_groups` needed no custom block.
 *
 * This is a plain function rather than part of the component so it can be
 * tested: the web app's vitest setup collects `.test.ts`, and there is no
 * React renderer in it.
 */

export interface SpaceChoice {
  /** What the person reads: a client's "Client - " prefix removed. */
  label: string;
  /** What the form submits. The caller decides id or canonical name. */
  value: string;
  space: Space;
}

export interface SpaceGroup {
  label: 'Spaces' | 'Clients';
  choices: SpaceChoice[];
}

/**
 * `valueOf` exists because the two callers need different values: the edit
 * form stores a space id, while the channel-mapping form submits a canonical
 * NAME, which is what `findSpaceExact` resolves. Getting that backwards once
 * already sent ids into a name lookup and quietly filed everything in Inbox.
 */
export function spaceGroups(
  spaces: Space[],
  valueOf: (space: Space) => string
): SpaceGroup[] {
  const internal: SpaceChoice[] = [];
  const clients: SpaceChoice[] = [];

  for (const space of spaces) {
    const choice: SpaceChoice = {
      label: shortSpaceName(space),
      value: valueOf(space),
      space,
    };
    (isClientSpace(space) ? clients : internal).push(choice);
  }

  const groups: SpaceGroup[] = [];
  // An empty group would render as an empty heading in the dropdown.
  if (internal.length > 0) groups.push({ label: 'Spaces', choices: internal });
  if (clients.length > 0) groups.push({ label: 'Clients', choices: clients });
  return groups;
}
