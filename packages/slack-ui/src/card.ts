import type { KnownBlock, Option } from '@slack/types';
import type { Space, Task } from '@tr/task-core';
import { metaLine, truncateLabel, type MetaOpts } from './label.js';

export const CHECKBOX_ACTION_ID = 'task_checkbox';
export const CHECKBOX_BLOCK_PREFIX = 'task_toggle';

/** `task_toggle:<groupIndex>:v<version>` */
export function checkboxBlockId(groupIndex: number, version: number): string {
  return `${CHECKBOX_BLOCK_PREFIX}:${groupIndex}:v${version}`;
}

/**
 * Reads the render version out of a block_id. Returns null for a block_id with
 * no version — a card posted before versioning existed.
 */
export function parseBlockVersion(blockId: string | undefined | null): number | null {
  const match = /:v(\d+)$/.exec(blockId ?? '');
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}
export const WAITING_ACTION_ID = 'task_waiting';
export const CONTROLS_BLOCK_PREFIX = 'task_controls';
/** Slack allows at most 10 options per checkboxes element. */
export const MAX_OPTIONS_PER_ELEMENT = 10;
/**
 * Slack rejects a message with more than 50 blocks. At 10 tasks per checkbox
 * element, 500 tasks is 50 blocks before a heading or a context note, which
 * pushed a full `/tasks <space>` message to 51 and failed the whole post.
 * 400 leaves room for the heading, the truncation note, and the overflow.
 */
export const MAX_ENTRIES_PER_MESSAGE = 400;

export interface CardEntry { task: Task; space: Space }
export interface CardGroup { heading: string | null; entries: CardEntry[] }

/**
 * Open  -> plain_text, so `* _ ~ backtick` stay literal.
 * Done  -> mrkdwn (strikethrough requires it) with verbatim, so URLs, @mentions
 *          and #channels inside a title are not rewritten into links.
 */
export function taskOption(task: Task, space: Space, opts: MetaOpts): Option {
  const { label } = truncateLabel(task.title);
  const description = metaLine(task, space, opts);

  const text =
    task.status === 'completed'
      ? ({ type: 'mrkdwn', text: `~${label}~`, verbatim: true } as const)
      : ({ type: 'plain_text', text: label, emoji: true } as const);

  const option = { text, value: task.id } as Option;
  if (description.length > 0) {
    (option as { description?: unknown }).description = {
      type: 'plain_text', text: description, emoji: true,
    };
  }
  return option;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * A secondary overflow for state changes the checkbox cannot express.
 * The checkbox remains the only control for open/completed — this never
 * duplicates completion, and there is no Reopen item because unchecking
 * the native checkbox is the reopen gesture.
 */
export function taskControlBlocks(entry: CardEntry, index = 0): KnownBlock[] {
  if (entry.task.status === 'completed') return [];
  const options =
    entry.task.status === 'waiting'
      ? [{ text: { type: 'plain_text' as const, text: 'Move to Open' }, value: `open:${entry.task.id}` }]
      : [{ text: { type: 'plain_text' as const, text: 'Move to Waiting' }, value: `waiting:${entry.task.id}` }];
  return [{
    type: 'actions',
    block_id: `${CONTROLS_BLOCK_PREFIX}:${index}`,
    elements: [{ type: 'overflow', action_id: WAITING_ACTION_ID, options }],
  } as unknown as KnownBlock];
}

export function taskCardBlocks(entries: CardEntry[], opts: MetaOpts): KnownBlock[] {
  if (entries.length === 0) return [];
  const blocks: KnownBlock[] = [];

  // Capped here rather than in each caller so no code path can build a message
  // Slack will refuse. The overflow is reported, never silently dropped.
  const shown = entries.slice(0, MAX_ENTRIES_PER_MESSAGE);
  const hidden = entries.length - shown.length;

  chunk(shown, MAX_OPTIONS_PER_ELEMENT).forEach((group, groupIndex) => {
    // Build each option exactly once. initial_options must contain the SAME
    // object references, or Slack fails to match them and a completed task
    // renders unchecked. See spec section 4.
    const options = group.map((e) => taskOption(e.task, e.space, opts));
    const initial = options.filter((_, i) => group[i]!.task.status === 'completed');

    const element: Record<string, unknown> = {
      type: 'checkboxes',
      action_id: CHECKBOX_ACTION_ID,
      options,
    };
    if (initial.length > 0) element.initial_options = initial;

    blocks.push({
      type: 'actions',
      block_id: checkboxBlockId(groupIndex, opts.version ?? 1),
      elements: [element],
    } as unknown as KnownBlock);
  });

  // A single-task card carries the secondary overflow. Driven off entry count
  // rather than a flag so a redraw always reproduces exactly what was posted.
  if (shown.length === 1) {
    blocks.push(...taskControlBlocks(shown[0]!));
  }

  // Any title too long for a 75-char option label keeps its exact form here.
  const truncated = shown.filter((e) => truncateLabel(e.task.title).truncated);
  if (truncated.length > 0) {
    blocks.push({
      type: 'context',
      elements: truncated.map((e) => ({
        type: 'plain_text' as const,
        text: `Full title: ${e.task.title}`,
        emoji: true,
      })),
    } as unknown as KnownBlock);
  }

  if (hidden > 0) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'plain_text',
        text: `Showing ${shown.length} of ${entries.length}. ${hidden} more not shown — narrow the scope.`,
        emoji: true,
      }],
    } as unknown as KnownBlock);
  }

  return blocks;
}

export function taskListBlocks(groups: CardGroup[], opts: MetaOpts): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  for (const group of groups) {
    if (group.entries.length === 0) continue;
    if (group.heading) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${group.heading}*` },
      } as KnownBlock);
    }
    blocks.push(...taskCardBlocks(group.entries, opts));
  }
  return blocks;
}

/**
 * Plain-text fallback used as the message `text` field for notifications.
 * Never empty: Slack rejects chat.update with no text and no blocks, which is
 * exactly the state a card reaches once every task on it is gone.
 */
export function taskCardFallback(entries: CardEntry[]): string {
  if (entries.length === 0) return 'No tasks';
  return entries
    .map((e) => (e.task.status === 'completed' ? `[x] ${e.task.title}` : `[ ] ${e.task.title}`))
    .join('\n');
}
