import type { Db } from '@tr/db';
import {
  listChannelMap, syncChannelMap, listSpaces, getInboxSpace,
  findSpaceExact, type Space, UnknownSpaceError,
} from '@tr/task-core';
import { listBatches, type ImportBatch } from '@tr/importer';
import { authorizedUserIds, timeZone } from '@/lib/env';
import type { OperationResult } from './tasks.js';

export interface SettingsView {
  channels: Array<{ channelId: string; channelName: string | null; spaceName: string }>;
  spaces: Space[];
  authorizedUserIds: string[];
  defaultSpaceName: string;
  timeZone: string;
  batches: ImportBatch[];
}

/**
 * Everything the settings page renders.
 *
 * Reads only from the database plus a narrow allowlist of non-secret
 * environment values. No token, key, or connection string is read here or
 * anywhere under `src/app`, and `no-secrets.test.ts` asserts that.
 */
export async function settingsView(db: Db): Promise<SettingsView> {
  const [channels, spaces, inbox, batches] = await Promise.all([
    listChannelMap(db),
    listSpaces(db),
    getInboxSpace(db),
    listBatches(db, 20),
  ]);

  return {
    channels,
    spaces,
    authorizedUserIds: authorizedUserIds(),
    defaultSpaceName: inbox.name,
    timeZone: timeZone(),
    batches,
  };
}

/**
 * Adds or remaps one channel.
 *
 * Goes through `syncChannelMap`, which validates the Space name and refuses an
 * unknown one, so a typo cannot create a mapping pointing nowhere.
 */
export async function setChannelMapping(
  db: Db,
  channelId: string,
  channelName: string | null,
  spaceName: string
): Promise<OperationResult> {
  const id = channelId.trim();
  if (!id) return { ok: false, error: 'A Slack channel ID is required.' };

  const space = await findSpaceExact(db, spaceName);
  if (!space) return { ok: false, error: `No Space matches "${spaceName}".` };

  try {
    await syncChannelMap(db, {
      [id]: { name: channelName?.trim() || undefined, space: spaceName },
    });
    return { ok: true, taskId: id };
  } catch (err) {
    if (err instanceof UnknownSpaceError) return { ok: false, error: err.message };
    throw err;
  }
}

export async function removeChannelMapping(
  db: Db, channelId: string
): Promise<OperationResult> {
  const id = channelId.trim();
  if (!id) return { ok: false, error: 'A Slack channel ID is required.' };
  await db.query(`DELETE FROM channel_space_map WHERE slack_channel_id = $1`, [id]);
  return { ok: true, taskId: id };
}
