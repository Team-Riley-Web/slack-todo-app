import type { Space } from '@tr/task-core';

/**
 * Mapping a channel to a Space, from inside Slack.
 *
 * This used to require editing `config/channel-map.json` and running
 * `pnpm sync-channels`, which is fine for a bulk rollout and absurd for "put
 * this channel's tasks in Marketing".
 *
 * A native `static_select` of the real Spaces, so there is nothing to type and
 * no name to get wrong. The first option unmaps the channel instead, because
 * removing a mapping has to be as reachable as adding one.
 */

export const MAP_CALLBACK_ID = 'channel_map_modal';
export const MAP_BLOCK = 'map_space';
export const MAP_ACTION = 'space';

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
  const none = { text: plain('— none, send to Inbox —'), value: MAP_NONE };
  const options = [
    none,
    ...spaces.map((s) => ({
      text: plain(s.name.slice(0, 75)),
      value: s.name,
    })),
  ];

  // Slack matches an initial option by exact equality, so the SAME object is
  // reused rather than a structural copy -- the trap the card taught us.
  const initial = current
    ? options.find((o) => o.value === current.name) ?? none
    : none;

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
          options,
          initial_option: initial,
        },
      },
    ],
  };
}

export interface ParsedMap {
  meta: MapMeta;
  /** Null means remove the mapping. */
  spaceName: string | null;
}

export function parseMapSubmission(view: Record<string, any>): ParsedMap {
  let meta: MapMeta;
  try {
    meta = JSON.parse(String(view?.private_metadata ?? '{}')) as MapMeta;
  } catch {
    meta = { channelId: '', channelName: null };
  }
  const selected =
    view?.state?.values?.[MAP_BLOCK]?.[MAP_ACTION]?.selected_option?.value;
  const spaceName =
    typeof selected === 'string' && selected.length > 0 && selected !== MAP_NONE
      ? selected
      : null;
  return { meta, spaceName };
}
