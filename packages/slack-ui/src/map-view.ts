import type { Space } from '@tr/task-core';
import { spaceOptionGroups } from './space-options.js';

/**
 * One modal for everything a channel's Space needs: pick an existing Space,
 * create a new one, or unmap.
 *
 * Reached by `/space`. It used to take `/tasks map` to pick one and
 * `/tasks new <name>` to create one -- two commands to remember for a single
 * idea. Creating a Space and pointing a channel at it is almost always the
 * same moment (a client signs, they get a channel), so it is one form now.
 *
 * `/space` rather than `/task space`, deliberately. A subcommand of `/task`
 * would have carved an exception into the one guarantee this system is built
 * on: that `/task <title>` stores the title byte for byte. Nobody could then
 * have a task called exactly "space". A separate command costs one line of
 * app manifest and keeps the title rule absolute.
 *
 * A native `static_select` of the real Spaces, so there is nothing to type and
 * no name to get wrong. The first option unmaps the channel instead, because
 * removing a mapping has to be as reachable as adding one. The text field
 * below creates a Space and points the channel at it in one submit.
 */

export const MAP_CALLBACK_ID = 'channel_map_modal';
export const MAP_BLOCK = 'map_space';
export const MAP_ACTION = 'space';
export const MAP_NEW_BLOCK = 'map_new_space';
export const MAP_NEW_ACTION = 'new_space';

/** The sentinel that means "no Space", i.e. remove the mapping. */
export const MAP_NONE = '__none__';

export interface MapMeta {
  channelId: string;
  channelName: string | null;
}

const plain = (text: string) => ({ type: 'plain_text' as const, text, emoji: true });
const mrkdwn = (text: string) => ({ type: 'mrkdwn' as const, text });

export function channelMapView(
  meta: MapMeta, spaces: Space[], current: Space | null
): Record<string, unknown> {
  /*
   * The VALUE is the Space NAME, not its id, because mapChannelToSpace feeds
   * it to findSpaceExact. Sending an id would resolve to nothing and every
   * capture would fall through to the Inbox.
   */
  const { groups, byValue } = spaceOptionGroups(
    spaces,
    (s) => s.name,
    { label: '— none, send to Inbox —', value: MAP_NONE }
  );

  // The SAME object, not a structural copy: Slack matches by exact equality.
  const initial = (current && byValue.get(current.name)) ?? byValue.get(MAP_NONE)!;

  const where = meta.channelName ? `*${meta.channelName}*` : 'this channel';

  return {
    type: 'modal',
    callback_id: MAP_CALLBACK_ID,
    title: plain('Channel to Space'),
    submit: plain('Save'),
    close: plain('Cancel'),
    private_metadata: JSON.stringify(meta),
    blocks: [
      {
        type: 'section',
        text: mrkdwn(
          `Tasks captured in ${where} with \`/task\` will land in the Space you ` +
          'pick. An unmapped channel sends them to Inbox.'
        ),
      },
      {
        type: 'input',
        block_id: MAP_BLOCK,
        label: plain('Space'),
        element: {
          type: 'static_select',
          action_id: MAP_ACTION,
          // option_groups and options are mutually exclusive; only one may be
          // sent.
          option_groups: groups,
          initial_option: initial,
        },
      },
      {
        type: 'input',
        block_id: MAP_NEW_BLOCK,
        optional: true,
        label: plain('…or create a new Space'),
        hint: plain('Creates it and points this channel at it. Overrides the picker above.'),
        element: {
          type: 'plain_text_input',
          action_id: MAP_NEW_ACTION,
          max_length: 80,
          placeholder: plain('e.g. Client - Rosario Landscaping'),
        },
      },
    ],
  };
}

export interface ParsedMap {
  meta: MapMeta;
  /** Null means remove the mapping — unless newSpaceName is set. */
  spaceName: string | null;
  /** A name typed in the create field. Wins over the picker when present. */
  newSpaceName: string | null;
}

export function parseMapSubmission(view: Record<string, any>): ParsedMap {
  let meta: MapMeta;
  try {
    meta = JSON.parse(String(view?.private_metadata ?? '{}')) as MapMeta;
  } catch {
    meta = { channelId: '', channelName: null };
  }
  const values = view?.state?.values ?? {};
  const selected = values?.[MAP_BLOCK]?.[MAP_ACTION]?.selected_option?.value;
  const spaceName =
    typeof selected === 'string' && selected.length > 0 && selected !== MAP_NONE
      ? selected
      : null;

  const rawNew = values?.[MAP_NEW_BLOCK]?.[MAP_NEW_ACTION]?.value;
  const newSpaceName =
    typeof rawNew === 'string' && rawNew.trim().length > 0 ? rawNew.trim() : null;

  return { meta, spaceName, newSpaceName };
}
