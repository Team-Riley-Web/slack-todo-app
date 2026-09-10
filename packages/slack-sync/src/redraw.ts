import type { Db } from '@tr/db';
import { getTask, listSpaces, type Space, type Task } from '@tr/task-core';
import {
  taskCardBlocks, taskListBlocks, taskCardFallback,
  type CardEntry, type CardGroup,
} from '@tr/slack-ui';
import { loadCard, saveCard } from './cards.js';

/**
 * What a redraw needs. Deliberately narrower than the Slack app's AppConfig, so
 * this package does not depend on `apps/slack` and the web app can use it too.
 */
export interface CardDeps {
  db: Db;
  client: { chat: { update: (args: Record<string, unknown>) => Promise<unknown> } };
  config: { timeZone: string; assigneeLabels?: Record<string, string> };
}

/** Reads every task back from the database and rewrites the same message. */
export async function redrawCard(
  deps: CardDeps,
  channelId: string,
  messageTs: string,
  taskIds: string[],
  viewScope: string | null
): Promise<void> {
  const { db, client, config } = deps;
  const existing = await loadCard(db, channelId, messageTs);
  // Compute the next version before rendering so the block_id stamped into the
  // message matches the version recorded alongside it.
  const version = (existing?.version ?? 0) + 1;
  const spaces = new Map((await listSpaces(db)).map((s: Space) => [s.id, s]));

  const entries: CardEntry[] = [];
  for (const id of taskIds) {
    const task: Task | null = await getTask(db, id).catch(() => null);
    const space = task ? spaces.get(task.space_id) : undefined;
    if (task && space) entries.push({ task, space });
  }

  const opts = {
    timeZone: config.timeZone, assigneeLabels: config.assigneeLabels, version,
  };
  await client.chat.update({
    channel: channelId,
    ts: messageTs,
    text: taskCardFallback(entries),
    blocks: renderEntries(entries, opts, spaces),
  });
  await saveCard(db, { channelId, messageTs, entries, viewScope, version });
}

/**
 * Rebuilds the same shape the message was posted in.
 *
 * A redraw used to call taskCardBlocks directly, which is one flat group with
 * no headings -- so ticking a single checkbox on a multi-Space list collapsed
 * the whole thing into an ungrouped run with the Space name repeated on every
 * row. The layout has to survive a redraw, not just the first post.
 *
 * A card spanning one Space stays flat: a heading naming the only Space on the
 * card would be its own kind of noise.
 */
function renderEntries(
  entries: CardEntry[],
  opts: { timeZone: string; assigneeLabels?: Record<string, string>; version: number },
  spaces: Map<string, Space>
) {
  const distinct = new Set(entries.map((e) => e.task.space_id));
  if (distinct.size <= 1) return taskCardBlocks(entries, opts);

  // Grouped in listSpaces order, so a redraw does not reshuffle the list under
  // the reader on every tick.
  const groups: CardGroup[] = [];
  for (const space of spaces.values()) {
    const inSpace = entries.filter((e) => e.task.space_id === space.id);
    if (inSpace.length > 0) {
      groups.push({ heading: space.name.toUpperCase(), entries: inSpace });
    }
  }
  return taskListBlocks(groups, opts);
}
