import type { Space, TaskStatus } from '@tr/task-core';
import { spaceOptionGroups } from './space-options.js';

/**
 * The full capture modal, opened by a bare `/task`.
 *
 * `/task <title>` stays the fast path and is untouched. This is for the times
 * a task needs more than a title: a Space that is not the channel's, a due
 * date, details, or a client Space that does not exist yet.
 *
 * The Space picker carries a companion text input. Slack has no
 * combobox-with-create, and a new client should not mean leaving the modal,
 * creating a Space elsewhere, and starting again -- so typing a name in "New
 * Space" creates it and puts the task in it. Filled, it wins over the picker.
 */

export const CAPTURE_CALLBACK_ID = 'task_capture_modal';

export const CAPTURE_BLOCKS = {
  title: 'capture_title',
  space: 'capture_space',
  newSpace: 'capture_new_space',
  status: 'capture_status',
  assignee: 'capture_assignee',
  due: 'capture_due',
  details: 'capture_details',
} as const;

/** Same cap as the edit modal: Slack's plain_text_input limit. */
export const CAPTURE_TEXT_MAX = 3000;

const STATUSES: readonly TaskStatus[] = ['open', 'waiting'];
const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  waiting: 'Waiting / Blocked',
};

export interface CaptureMeta {
  channelId: string;
  /** The Space the channel maps to, preselected in the picker. */
  defaultSpaceId: string | null;
}

const plain = (text: string) => ({ type: 'plain_text' as const, text, emoji: true });

export function captureTaskView(
  meta: CaptureMeta, spaces: Space[]
): Record<string, unknown> {
  // Grouped into Spaces and Clients, so a correctly sorted list also reads
  // that way. Built once and reused in initial_option: Slack matches an
  // initial option by exact equality, not structural equality.
  const { groups: spaceGroups, byValue } = spaceOptionGroups(spaces, (s) => s.id);
  const initialSpace = meta.defaultSpaceId
    ? byValue.get(meta.defaultSpaceId)
    : undefined;

  const statusOptions = STATUSES.map((s) => ({
    text: plain(STATUS_LABELS[s]!),
    value: s,
  }));

  return {
    type: 'modal',
    callback_id: CAPTURE_CALLBACK_ID,
    title: plain('New task'),
    submit: plain('Create'),
    close: plain('Cancel'),
    private_metadata: JSON.stringify(meta),
    blocks: [
      {
        type: 'input',
        block_id: CAPTURE_BLOCKS.title,
        label: plain('Task'),
        element: {
          type: 'plain_text_input',
          action_id: 'title',
          max_length: CAPTURE_TEXT_MAX,
          placeholder: plain('Stored exactly as you type it'),
        },
      },
      {
        type: 'input',
        block_id: CAPTURE_BLOCKS.space,
        label: plain('Space'),
        element: {
          type: 'static_select',
          action_id: 'space',
          option_groups: spaceGroups,
          ...(initialSpace ? { initial_option: initialSpace } : {}),
        },
      },
      {
        type: 'input',
        block_id: CAPTURE_BLOCKS.newSpace,
        optional: true,
        label: plain('…or a new Space'),
        hint: plain('Creates it and puts this task in it. Overrides the picker above.'),
        element: {
          type: 'plain_text_input',
          action_id: 'new_space',
          max_length: 80,
          placeholder: plain('e.g. Client - Rosario Landscaping'),
        },
      },
      {
        type: 'input',
        block_id: CAPTURE_BLOCKS.status,
        label: plain('Status'),
        element: {
          type: 'radio_buttons',
          action_id: 'status',
          options: statusOptions,
          initial_option: statusOptions[0],
        },
      },
      {
        type: 'input',
        block_id: CAPTURE_BLOCKS.assignee,
        optional: true,
        label: plain('Assignee'),
        element: { type: 'users_select', action_id: 'assignee' },
      },
      {
        type: 'input',
        block_id: CAPTURE_BLOCKS.due,
        optional: true,
        label: plain('Due'),
        element: { type: 'datetimepicker', action_id: 'due' },
      },
      {
        type: 'input',
        block_id: CAPTURE_BLOCKS.details,
        optional: true,
        label: plain('Details'),
        element: {
          type: 'plain_text_input',
          action_id: 'details',
          multiline: true,
          max_length: CAPTURE_TEXT_MAX,
        },
      },
    ],
  };
}

export interface ParsedCapture {
  meta: CaptureMeta;
  title: string;
  spaceId: string | null;
  /** Set when a name was typed in the new-Space field. */
  newSpaceName: string | null;
  status: TaskStatus;
  assigneeId: string | null;
  dueAt: Date | null;
  details: string | null;
  error?: { blockId: string; message: string };
}

export function parseCaptureSubmission(view: Record<string, any>): ParsedCapture {
  let meta: CaptureMeta;
  try {
    meta = JSON.parse(String(view?.private_metadata ?? '{}')) as CaptureMeta;
  } catch {
    meta = { channelId: '', defaultSpaceId: null };
  }

  const values = view?.state?.values ?? {};
  const at = (blockId: string, actionId: string): Record<string, unknown> =>
    (values?.[blockId]?.[actionId] ?? {}) as Record<string, unknown>;

  const rawTitle = at(CAPTURE_BLOCKS.title, 'title').value;
  // Only the outer trim, the same single normalization /task performs.
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';

  const rawNew = at(CAPTURE_BLOCKS.newSpace, 'new_space').value;
  const newSpaceName =
    typeof rawNew === 'string' && rawNew.trim().length > 0 ? rawNew.trim() : null;

  const spaceOption = at(CAPTURE_BLOCKS.space, 'space').selected_option as
    | { value?: string } | null | undefined;
  const statusOption = at(CAPTURE_BLOCKS.status, 'status').selected_option as
    | { value?: string } | null | undefined;
  const selectedUser = at(CAPTURE_BLOCKS.assignee, 'assignee').selected_user;
  const selectedDateTime = at(CAPTURE_BLOCKS.due, 'due').selected_date_time;
  const rawDetails = at(CAPTURE_BLOCKS.details, 'details').value;

  const base: ParsedCapture = {
    meta,
    title,
    spaceId: spaceOption?.value ?? null,
    newSpaceName,
    status: statusOption?.value === 'waiting' ? 'waiting' : 'open',
    assigneeId:
      typeof selectedUser === 'string' && selectedUser.length > 0 ? selectedUser : null,
    dueAt: typeof selectedDateTime === 'number' ? new Date(selectedDateTime * 1000) : null,
    details:
      typeof rawDetails === 'string' && rawDetails.length > 0 ? rawDetails : null,
  };

  if (title.length === 0) {
    return {
      ...base,
      error: { blockId: CAPTURE_BLOCKS.title, message: 'A task needs a title.' },
    };
  }
  if (!base.spaceId && !newSpaceName) {
    return {
      ...base,
      error: { blockId: CAPTURE_BLOCKS.space, message: 'Choose a Space, or name a new one.' },
    };
  }

  return base;
}
