import type { KnownBlock } from '@slack/types';
import type { TaskGroup, TaskInSpace } from '@tr/task-core';
import {
  headerBlock, taskCardFallback, taskListBlocks,
  MAX_BLOCKS_PER_MESSAGE,
  type CardGroup, type MetaOpts,
} from '@tr/slack-ui';

/**
 * How many tasks go into one Space heading before it is continued under a
 * second heading.
 *
 * `taskCardBlocks` silently caps a single group at 400 entries and replaces the
 * rest with a "narrow the scope" note. That is right for a slash command
 * someone can re-run; it is wrong for a briefing, which must show every task
 * it was handed -- the briefing decides what to leave out, and says so.
 * Chunking well below the cap means the cap never fires, at a cost of one
 * extra heading per hundred tasks in a Space.
 */
export const GROUP_CHUNK = 100;

export interface PlannedMessage {
  blocks: KnownBlock[];
  text: string;
  /** Exactly the tasks rendered here, so `saveCard` records this message. */
  entries: TaskInSpace[];
}

/** Splits any group too large to render intact into continued headings. */
function chunkGroups(groups: TaskGroup[]): TaskGroup[] {
  const out: TaskGroup[] = [];
  for (const group of groups) {
    if (group.entries.length <= GROUP_CHUNK) {
      out.push(group);
      continue;
    }
    for (let i = 0; i < group.entries.length; i += GROUP_CHUNK) {
      out.push({
        heading: i === 0 ? group.heading : `${group.heading} (CONT.)`,
        entries: group.entries.slice(i, i + GROUP_CHUNK),
      });
    }
  }
  return out;
}

/**
 * True when Slack would accept this message AND nothing was quietly dropped
 * from it.
 *
 * Checked by rendering rather than by estimating block counts. An estimate
 * that drifted from `taskListBlocks` by one block would not error -- it would
 * hand back a message with a "2 more Spaces not shown" note in place of real
 * tasks, which is the one outcome a digest must never produce. Counting the
 * headings that came out against the groups that went in catches that
 * exactly.
 */
function rendersIntact(
  blocks: KnownBlock[], groups: TaskGroup[], reserved: number
): boolean {
  if (blocks.length + reserved > MAX_BLOCKS_PER_MESSAGE) return false;
  const headings = blocks.filter((b) => (b as { type?: string }).type === 'header').length;
  return headings === groups.length;
}

/**
 * Lays a briefing out across as many messages as it takes to show every task
 * it was given, then closes with `footer` when there is one.
 *
 * Slack caps a message at 50 blocks, and `/tasks all` handles that by dropping
 * whole Spaces with a note. A briefing cannot: what to leave out is decided
 * BEFORE planning (`focusGroups`), and anything left here must render. So
 * groups are packed greedily into
 * messages, and a group that will not fit alongside what is already there
 * starts the next message instead of being cut.
 *
 * Each message is rendered by the same `taskListBlocks` the slash command
 * uses, so the checkboxes, meta lines and headings are identical -- and each
 * carries its own entries, so every message gets its own `slack_cards` row and
 * every checkbox in every message stays live.
 */
export function planTaskMessages(
  heading: string, groups: TaskGroup[], opts: MetaOpts, footer?: string
): PlannedMessage[] {
  const messages = planBody(heading, groups, opts);
  if (!footer) return messages;

  // The footer closes the LAST message, or starts one of its own when that
  // message is already at Slack's block cap.
  const block = {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: footer }],
  } as KnownBlock;
  const last = messages[messages.length - 1]!;
  if (last.blocks.length < MAX_BLOCKS_PER_MESSAGE) {
    last.blocks.push(block);
    last.text = `${last.text}\n${footer}`;
  } else {
    messages.push({ blocks: [block], text: footer, entries: [] });
  }
  return messages;
}

function planBody(
  heading: string, groups: TaskGroup[], opts: MetaOpts
): PlannedMessage[] {
  const chunked = chunkGroups(groups).filter((g) => g.entries.length > 0);

  if (chunked.length === 0) {
    return [{
      blocks: [
        headerBlock(heading),
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '_Nothing open._' },
        } as KnownBlock,
      ],
      text: `${heading}\nNothing open.`,
      entries: [],
    }];
  }

  const messages: PlannedMessage[] = [];
  let pending: TaskGroup[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    const first = messages.length === 0;
    const entries = pending.flatMap((g) => g.entries);
    const blocks = taskListBlocks(pending as CardGroup[], opts);
    messages.push({
      blocks: first ? [headerBlock(heading), ...blocks] : blocks,
      text: `${first ? heading : `${heading} (continued)`}\n${taskCardFallback(entries)}`,
      entries,
    });
    pending = [];
  };

  for (const group of chunked) {
    /*
     * The first message carries the digest's own header, so it is packed one
     * block shallower than the rest. `messages.length` is the test, not
     * `pending.length`: every group being packed while no message has been
     * emitted yet belongs to that first, shallower message.
     */
    const reserved = messages.length === 0 ? 1 : 0;
    const candidate = [...pending, group];
    if (rendersIntact(taskListBlocks(candidate as CardGroup[], opts), candidate, reserved)) {
      pending = candidate;
      continue;
    }
    // It does not fit alongside what is pending. Send that, then start fresh.
    flush();
    pending = [group];
  }
  flush();

  return messages;
}
