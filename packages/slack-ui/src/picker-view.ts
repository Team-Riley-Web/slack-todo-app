import type { Space, Task } from '@tr/task-core';
import { truncateLabel, metaLine, type MetaOpts } from './label.js';

/**
 * The task picker.
 *
 * A message shortcut targets a whole message, not one task inside it. A card
 * posted by `/tasks` can hold many tasks, so when the shortcut cannot tell
 * which one is meant it asks -- rather than guessing, or silently acting on
 * the first.
 *
 * A single-task card never reaches this view: the shortcut acts directly.
 */

export const PICKER_CALLBACK_ID = 'task_picker_modal';
export const PICKER_BLOCK = 'picker_task';
export const PICKER_ACTION = 'task';

/** Slack allows at most 10 options in radio_buttons; beyond that use a select. */
const MAX_RADIO_OPTIONS = 10;

export type PickerAction = 'edit' | 'waiting';

export interface PickerMeta {
  action: PickerAction;
  channelId: string;
  messageTs: string;
}

export interface PickerEntry { task: Task; space: Space }

const plain = (text: string) => ({ type: 'plain_text' as const, text, emoji: true });

const TITLES: Record<PickerAction, string> = {
  edit: 'Edit which task?',
  waiting: 'Which task?',
};

const SUBMITS: Record<PickerAction, string> = {
  edit: 'Edit',
  waiting: 'Move',
};

export function taskPickerView(
  meta: PickerMeta, entries: PickerEntry[], opts: MetaOpts
): Record<string, unknown> {
  const options = entries.slice(0, 100).map((entry) => {
    const { label } = truncateLabel(entry.task.title);
    const description = metaLine(entry.task, entry.space, opts);
    const option: Record<string, unknown> = {
      text: plain(label),
      value: entry.task.id,
    };
    // Same platform constraint as the card: option.description is plain_text
    // only, so the meta line stays server-formatted here too.
    if (description.length > 0) option.description = plain(description);
    return option;
  });

  const element: Record<string, unknown> =
    options.length <= MAX_RADIO_OPTIONS
      ? { type: 'radio_buttons', action_id: PICKER_ACTION, options }
      : {
          type: 'static_select',
          action_id: PICKER_ACTION,
          placeholder: plain('Choose a task'),
          options,
        };

  return {
    type: 'modal',
    callback_id: PICKER_CALLBACK_ID,
    title: plain(TITLES[meta.action]),
    submit: plain(SUBMITS[meta.action]),
    close: plain('Cancel'),
    private_metadata: JSON.stringify(meta),
    blocks: [
      {
        type: 'input',
        block_id: PICKER_BLOCK,
        label: plain(
          meta.action === 'edit'
            ? 'This message has several tasks.'
            : 'Move which task to or from waiting?'
        ),
        element,
      },
    ],
  };
}

export interface ParsedPick {
  meta: PickerMeta;
  taskId: string | null;
}

export function parsePickerSubmission(view: Record<string, any>): ParsedPick {
  let meta: PickerMeta;
  try {
    meta = JSON.parse(String(view?.private_metadata ?? '{}')) as PickerMeta;
  } catch {
    meta = { action: 'edit', channelId: '', messageTs: '' };
  }
  const selected =
    view?.state?.values?.[PICKER_BLOCK]?.[PICKER_ACTION]?.selected_option?.value;
  return {
    meta,
    taskId: typeof selected === 'string' && selected.length > 0 ? selected : null,
  };
}
