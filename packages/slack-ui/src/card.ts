import type { KnownBlock, Option } from '@slack/types';
import type { Space, Task } from '@tr/task-core';
import { metaLine, truncateLabel, type MetaOpts } from './label.js';

export const CHECKBOX_ACTION_ID = 'task_checkbox';
export const CHECKBOX_BLOCK_PREFIX = 'task_toggle';
export const WAITING_ACTION_ID = 'task_waiting';
export const CONTROLS_BLOCK_PREFIX = 'task_controls';
/** Slack allows at most 10 options per checkboxes element. */
export const MAX_OPTIONS_PER_ELEMENT = 10;

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

export function taskCardBlocks(entries: CardEntry[], opts: MetaOpts): KnownBlock[] {
  if (entries.length === 0) return [];
  const blocks: KnownBlock[] = [];

  chunk(entries, MAX_OPTIONS_PER_ELEMENT).forEach((group, groupIndex) => {
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
      block_id: `${CHECKBOX_BLOCK_PREFIX}:${groupIndex}`,
      elements: [element],
    } as unknown as KnownBlock);
  });

  // Any title too long for a 75-char option label keeps its exact form here.
  const truncated = entries.filter((e) => truncateLabel(e.task.title).truncated);
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

  return blocks;
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

/** Plain-text fallback used as the message `text` field for notifications. */
export function taskCardFallback(entries: CardEntry[]): string {
  return entries
    .map((e) => (e.task.status === 'completed' ? `[x] ${e.task.title}` : `[ ] ${e.task.title}`))
    .join('\n');
}
