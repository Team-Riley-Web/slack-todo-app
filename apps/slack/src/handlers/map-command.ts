import type { Db } from '@tr/db';
import {
  getSpaceForChannel, listSpaces, mapChannelToSpace, unmapChannel,
  createSpace, UnknownSpaceError, type Space,
} from '@tr/task-core';
import {
  channelMapView, parseMapSubmission, MAP_BLOCK, MAP_NEW_BLOCK,
  type MapMeta,
} from '@tr/slack-ui';
import { authorize } from '../auth.js';
import type { AppConfig } from '../config.js';
import type { SlashCommandLike } from './task-command.js';

export { MAP_CALLBACK_ID, MAP_BLOCK, MAP_ACTION, MAP_NONE } from '@tr/slack-ui';

/**
 * `/space` — everything a channel's Space needs, in one modal.
 *
 * Pick an existing Space, create a new one, or unmap. `/tasks map` and
 * `/tasks new <name>` still work so nothing breaks mid-session, but they are
 * no longer the documented path: two commands for one idea is one too many to
 * remember.
 */

export interface MapDeps {
  db: Db;
  client: {
    views: { open: (args: Record<string, unknown>) => Promise<unknown> };
    chat: { postEphemeral: (args: Record<string, unknown>) => Promise<unknown> };
  };
  config: AppConfig;
}

export type MapOutcome = 'opened' | 'unauthorized' | 'no_channel';

/** True when the /tasks text is asking for the mapping modal. */
export function isMapCommand(text: string | undefined | null): boolean {
  return (text ?? '').trim().toLowerCase() === 'map';
}

export async function handleMapCommand(
  deps: MapDeps, command: SlashCommandLike
): Promise<{ outcome: MapOutcome }> {
  const auth = authorize(
    { team: { id: command.team_id }, user: { id: command.user_id } } as never,
    deps.config
  );
  if (!auth.ok) return { outcome: 'unauthorized' };

  const channelId = command.channel_id ?? '';
  if (!channelId) return { outcome: 'no_channel' };

  const [spaces, context] = await Promise.all([
    listSpaces(deps.db),
    getSpaceForChannel(deps.db, channelId),
  ]);

  const rawName = command.channel_name;
  const meta: MapMeta = {
    channelId,
    // Slack sends the name without a leading '#'; add it so the modal reads
    // the way the channel does in the sidebar.
    channelName: rawName ? (rawName.startsWith('#') ? rawName : `#${rawName}`) : null,
  };

  await deps.client.views.open({
    trigger_id: command.trigger_id,
    view: channelMapView(
      meta, spaces as Space[], context.mapped ? (context.space as Space) : null
    ),
  });
  return { outcome: 'opened' };
}

export type MapSubmitOutcome =
  | 'mapped' | 'created' | 'unmapped' | 'unchanged' | 'unauthorized' | 'invalid';

export interface MapSubmitResult {
  outcome: MapSubmitOutcome;
  error?: { blockId: string; message: string };
}

export async function handleMapSubmission(
  deps: MapDeps, body: Record<string, any>
): Promise<MapSubmitResult> {
  const auth = authorize(body as never, deps.config);
  if (!auth.ok) return { outcome: 'unauthorized' };

  const { meta, spaceName, newSpaceName } = parseMapSubmission(body?.view ?? {});
  if (!meta.channelId) return { outcome: 'invalid' };

  /**
   * A typed name wins over the picker, and creating is idempotent, so the
   * same client name twice points the channel at the existing Space instead
   * of failing.
   */
  if (newSpaceName) {
    const created = await createSpace(deps.db, newSpaceName);
    if (!created.ok || !created.space) {
      return {
        outcome: 'invalid',
        error: {
          blockId: MAP_NEW_BLOCK,
          message: created.error ?? 'Could not create that Space.',
        },
      };
    }
    await mapChannelToSpace(deps.db, {
      channelId: meta.channelId,
      channelName: meta.channelName,
      spaceName: created.space.name,
    });
    await tell(
      deps, meta.channelId, auth.userId,
      created.existed
        ? `*${created.space.name}* already existed. ${meta.channelName ?? 'This channel'} now maps to it.`
        : `Created *${created.space.name}* and mapped ${meta.channelName ?? 'this channel'} to it.`
    );
    return { outcome: created.existed ? 'mapped' : 'created' };
  }

  if (spaceName === null) {
    const removed = await unmapChannel(deps.db, meta.channelId);
    await tell(
      deps, meta.channelId, auth.userId,
      removed
        ? `${meta.channelName ?? 'This channel'} is no longer mapped. New tasks go to Inbox.`
        : `${meta.channelName ?? 'This channel'} was already unmapped.`
    );
    return { outcome: removed ? 'unmapped' : 'unchanged' };
  }

  try {
    const space = await mapChannelToSpace(deps.db, {
      channelId: meta.channelId,
      channelName: meta.channelName,
      spaceName,
    });
    await tell(
      deps, meta.channelId, auth.userId,
      `${meta.channelName ?? 'This channel'} now maps to *${space.name}*. ` +
      'New tasks captured here land there.'
    );
    return { outcome: 'mapped' };
  } catch (err) {
    if (err instanceof UnknownSpaceError) {
      // Surfaced on the field natively rather than as a message, so the modal
      // stays open with the choice still in it.
      return {
        outcome: 'invalid',
        error: { blockId: MAP_BLOCK, message: `No Space matches "${spaceName}".` },
      };
    }
    throw err;
  }
}

/** Ephemeral: a mapping change is not news the whole channel needs. */
async function tell(
  deps: MapDeps, channelId: string, userId: string | null, text: string
): Promise<void> {
  if (!userId) return;
  try {
    await deps.client.chat.postEphemeral({ channel: channelId, user: userId, text });
  } catch {
    // A failed confirmation must not undo a mapping that already succeeded.
  }
}
