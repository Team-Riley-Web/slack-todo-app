import type { Space, Task, TaskStatus, EditableFields } from '@tr/task-core';
import type { MetaOpts } from './label.js';
import { spaceOptionGroups } from './space-options.js';

export const EDIT_ACTION_ID = 'task_edit';
export const EDIT_CALLBACK_ID = 'task_edit_modal';

/**
 * Fixed block and action ids, so the submission parser can read
 * `view.state.values` deterministically rather than by position.
 */
export const EDIT_BLOCKS = {
  title: 'edit_title',
  space: 'edit_space',
  status: 'edit_status',
  assignee: 'edit_assignee',
  due: 'edit_due',
  waitingOn: 'edit_waiting_on',
  details: 'edit_details',
} as const;

const STATUSES: readonly TaskStatus[] = ['open', 'waiting', 'completed'];
const STATUS_LABELS: Record<TaskStatus, string> = {
  open: 'Open',
  waiting: 'Waiting / Blocked',
  completed: 'Completed',
};

/** Slack's cap on plain_text_input. A longer title can only be edited on the web. */
export const MODAL_TEXT_MAX = 3000;

export interface EditMeta {
  taskId: string;
  channelId: string;
  messageTs: string;
}

/**
 * The full-field edit modal, built entirely from native Block Kit elements:
 * plain_text_input, static_select, radio_buttons, users_select, datetimepicker.
 *
 * Every field sits in a block of `type: 'input'` because Slack documents that
 * ONLY input blocks appear in `view_submission` state values — a field placed
 * in a section accessory would silently never arrive on submit.
 *
 * Slack's own guidance suggests paginating above six inputs. This has seven,
 * all short, and splitting one task's fields across two views would cost more
 * than it saves, so it stays a single view. Deliberate departure, recorded.
 */
export function editTaskView(
  task: Task, spaces: Space[], meta: EditMeta, _opts: MetaOpts
): Record<string, unknown> {
  // Build each option exactly once and reference the same object in
  // initial_option. Slack matches initial options by exact equality, and the
  // card's initial_options trap taught us that a structural copy is not enough.
  const { groups: spaceGroups, byValue } = spaceOptionGroups(spaces, (s) => s.id);
  const initialSpace = byValue.get(task.space_id);

  const statusOptions = STATUSES.map((s) => ({
    text: { type: 'plain_text' as const, text: STATUS_LABELS[s] },
    value: s,
  }));
  const initialStatus = statusOptions.find((o) => o.value === task.status)!;

  const blocks: Record<string, unknown>[] = [
    {
      type: 'input',
      block_id: EDIT_BLOCKS.title,
      label: { type: 'plain_text', text: 'Title' },
      hint: { type: 'plain_text', text: 'Stored exactly as typed.' },
      element: {
        type: 'plain_text_input',
        action_id: 'title',
        initial_value: task.title.slice(0, MODAL_TEXT_MAX),
        max_length: MODAL_TEXT_MAX,
      },
    },
    {
      type: 'input',
      block_id: EDIT_BLOCKS.space,
      label: { type: 'plain_text', text: 'Space' },
      element: {
        type: 'static_select',
        action_id: 'space',
        option_groups: spaceGroups,
        ...(initialSpace ? { initial_option: initialSpace } : {}),
      },
    },
    {
      type: 'input',
      block_id: EDIT_BLOCKS.status,
      label: { type: 'plain_text', text: 'Status' },
      element: {
        type: 'radio_buttons',
        action_id: 'status',
        options: statusOptions,
        initial_option: initialStatus,
      },
    },
    {
      type: 'input',
      block_id: EDIT_BLOCKS.assignee,
      optional: true,
      label: { type: 'plain_text', text: 'Assignee' },
      hint: { type: 'plain_text', text: 'Leave empty to unassign.' },
      element: {
        type: 'users_select',
        action_id: 'assignee',
        ...(task.assignee_id ? { initial_user: task.assignee_id } : {}),
      },
    },
    {
      type: 'input',
      block_id: EDIT_BLOCKS.due,
      optional: true,
      label: { type: 'plain_text', text: 'Due' },
      hint: { type: 'plain_text', text: 'Leave empty to clear.' },
      element: {
        type: 'datetimepicker',
        action_id: 'due',
        ...(task.due_at
          ? { initial_date_time: Math.floor(task.due_at.getTime() / 1000) }
          : {}),
      },
    },
    {
      type: 'input',
      block_id: EDIT_BLOCKS.waitingOn,
      optional: true,
      label: { type: 'plain_text', text: 'Waiting on' },
      hint: { type: 'plain_text', text: 'Only used when status is Waiting / Blocked.' },
      element: {
        type: 'plain_text_input',
        action_id: 'waiting_on',
        ...(task.waiting_on ? { initial_value: task.waiting_on.slice(0, MODAL_TEXT_MAX) } : {}),
        max_length: MODAL_TEXT_MAX,
      },
    },
    {
      type: 'input',
      block_id: EDIT_BLOCKS.details,
      optional: true,
      label: { type: 'plain_text', text: 'Details' },
      element: {
        // plain_text_input, NOT rich_text_input: details holds imported source
        // text that must round-trip byte-exact, and a rich-text structure would
        // not. The more-native-looking element is the wrong one here.
        type: 'plain_text_input',
        action_id: 'details',
        multiline: true,
        ...(task.details ? { initial_value: task.details.slice(0, MODAL_TEXT_MAX) } : {}),
        max_length: MODAL_TEXT_MAX,
      },
    },
  ];

  return {
    type: 'modal',
    callback_id: EDIT_CALLBACK_ID,
    title: { type: 'plain_text', text: 'Edit task' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    notify_on_close: false,
    private_metadata: JSON.stringify(meta),
    blocks,
  };
}

/** Slack sends `null` for a cleared optional input; an empty string means the same. */
function textOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return raw.length === 0 ? null : raw;
}

export interface ParsedEdit {
  meta: EditMeta;
  patch: EditableFields;
  /** Set when the submission cannot be applied; the caller renders a field error. */
  error?: { blockId: string; message: string };
}

/**
 * Reads a `view_submission` into an EditableFields patch.
 *
 * Every value comes from `view.state.values`, which Slack populates only from
 * input blocks. A field is included in the patch even when unchanged, so
 * `editTask` can compare against current state and no-op if nothing moved.
 */
export function parseEditSubmission(view: Record<string, any>): ParsedEdit {
  let meta: EditMeta;
  try {
    meta = JSON.parse(String(view?.private_metadata ?? '{}')) as EditMeta;
  } catch {
    meta = { taskId: '', channelId: '', messageTs: '' };
  }

  const values = view?.state?.values ?? {};
  const at = (blockId: string, actionId: string): Record<string, unknown> =>
    (values?.[blockId]?.[actionId] ?? {}) as Record<string, unknown>;

  const rawTitle = at(EDIT_BLOCKS.title, 'title').value;
  const title = typeof rawTitle === 'string' ? rawTitle : '';
  if (title.trim().length === 0) {
    return {
      meta,
      patch: {},
      error: { blockId: EDIT_BLOCKS.title, message: 'Title cannot be empty.' },
    };
  }

  const spaceOption = at(EDIT_BLOCKS.space, 'space').selected_option as
    | { value?: string } | null | undefined;
  const statusOption = at(EDIT_BLOCKS.status, 'status').selected_option as
    | { value?: string } | null | undefined;
  const selectedUser = at(EDIT_BLOCKS.assignee, 'assignee').selected_user;
  const selectedDateTime = at(EDIT_BLOCKS.due, 'due').selected_date_time;

  const patch: EditableFields = {
    title,
    assigneeId: typeof selectedUser === 'string' && selectedUser.length > 0
      ? selectedUser
      : null,
    dueAt: typeof selectedDateTime === 'number'
      ? new Date(selectedDateTime * 1000)
      : null,
    waitingOn: textOrNull(at(EDIT_BLOCKS.waitingOn, 'waiting_on').value),
    details: textOrNull(at(EDIT_BLOCKS.details, 'details').value),
  };
  if (spaceOption?.value) patch.spaceId = spaceOption.value;
  if (statusOption?.value) patch.status = statusOption.value as TaskStatus;

  return { meta, patch };
}
