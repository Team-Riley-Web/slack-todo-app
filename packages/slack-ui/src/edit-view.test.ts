import { describe, it, expect } from 'vitest';
import {
  editTaskView, parseEditSubmission, EDIT_BLOCKS, EDIT_CALLBACK_ID, MODAL_TEXT_MAX,
} from './edit-view.js';
import { taskControlBlocks } from './card.js';
import type { Task, Space } from '@tr/task-core';

const spaces: Space[] = [
  { id: 's-mkt', name: 'Marketing', slug: 'marketing', is_inbox: false },
  { id: 's-nl', name: 'Client - Nazareth Law', slug: 'nazareth-law', is_inbox: false },
];
const opts = { timeZone: 'America/Chicago', assigneeLabels: { U_JOSH: 'Joshua' } };
const meta = { taskId: 'T1', channelId: 'C1', messageTs: '1.1' };

const task = (over: Partial<Task> = {}): Task => ({
  id: 'T1', title: 'Call Neil', space_id: 's-mkt', list_id: null, assignee_id: null,
  status: 'open', due_at: null, waiting_on: null, details: null, created_at: new Date(),
  completed_at: null, source_platform: 'slack', source_channel_id: null,
  source_message_ts: null, created_by: null,
  source_external_id: null, import_batch_id: null, ...over,
});

const view = (t: Task = task()) => editTaskView(t, spaces, meta, opts) as any;
const block = (v: any, id: string) => v.blocks.find((b: any) => b.block_id === id);

describe('every field is an input block', () => {
  // Slack: only input blocks appear in view_submission state values. A field in
  // a section accessory would silently never arrive on submit.
  it('puts all seven fields in blocks of type input', () => {
    const v = view();
    const ids = Object.values(EDIT_BLOCKS);
    expect(ids).toHaveLength(7);
    for (const id of ids) {
      const b = block(v, id);
      expect(b, `${id} must exist`).toBeDefined();
      expect(b.type, `${id} must be an input block`).toBe('input');
      expect(b.element).toBeDefined();
    }
  });

  it('has no non-input interactive block', () => {
    const v = view();
    const interactive = v.blocks.filter((b: any) => b.type !== 'input');
    expect(interactive).toEqual([]);
  });
});

describe('native elements', () => {
  it('uses the native element for each field', () => {
    const v = view();
    expect(block(v, EDIT_BLOCKS.title).element.type).toBe('plain_text_input');
    expect(block(v, EDIT_BLOCKS.space).element.type).toBe('static_select');
    expect(block(v, EDIT_BLOCKS.status).element.type).toBe('radio_buttons');
    expect(block(v, EDIT_BLOCKS.assignee).element.type).toBe('users_select');
    expect(block(v, EDIT_BLOCKS.due).element.type).toBe('datetimepicker');
    expect(block(v, EDIT_BLOCKS.details).element.multiline).toBe(true);
  });

  it('uses plain_text_input for details, not rich_text_input', () => {
    // rich_text_input returns a structure, and details must round-trip
    // byte-exact for imported source text.
    expect(block(view(), EDIT_BLOCKS.details).element.type).toBe('plain_text_input');
    expect(JSON.stringify(view())).not.toContain('rich_text_input');
  });
});

describe('modal shape', () => {
  it('carries the callback id and a submit button', () => {
    const v = view();
    expect(v.type).toBe('modal');
    expect(v.callback_id).toBe(EDIT_CALLBACK_ID);
    expect(v.submit.type).toBe('plain_text');
    expect(v.close.type).toBe('plain_text');
  });

  it('round-trips private_metadata', () => {
    expect(JSON.parse(view().private_metadata)).toEqual(meta);
  });
});

describe('prefilled values', () => {
  it('prefills the title byte-exact', () => {
    for (const title of [
      'Waiting on Milltown’s reply to the email proposal',
      'Secure Logic — three-month honeymoon check-in with Marty',
      'fix *urgent* bug',
    ]) {
      expect(block(view(task({ title })), EDIT_BLOCKS.title).element.initial_value)
        .toBe(title);
    }
  });

  it('caps a very long title at Slack limit rather than failing', () => {
    const el = block(view(task({ title: 'x'.repeat(5000) })), EDIT_BLOCKS.title).element;
    expect(el.initial_value.length).toBe(MODAL_TEXT_MAX);
    expect(el.max_length).toBe(MODAL_TEXT_MAX);
  });

  it('selects the current space by object identity with its option', () => {
    const el = block(view(task({ space_id: 's-nl' })), EDIT_BLOCKS.space).element;
    expect(el.initial_option.value).toBe('s-nl');
    expect(el.options).toContain(el.initial_option); // same reference, not a copy
  });

  it('selects the current status by object identity, with three options', () => {
    const el = block(view(task({ status: 'waiting' })), EDIT_BLOCKS.status).element;
    expect(el.options).toHaveLength(3);
    expect(el.initial_option.value).toBe('waiting');
    expect(el.options).toContain(el.initial_option);
  });

  it('omits initial_user when unassigned and sets it when assigned', () => {
    expect(block(view(), EDIT_BLOCKS.assignee).element.initial_user).toBeUndefined();
    expect(block(view(task({ assignee_id: 'U_JOSH' })), EDIT_BLOCKS.assignee).element.initial_user)
      .toBe('U_JOSH');
  });

  it('omits initial_date_time when there is no due date', () => {
    expect(block(view(), EDIT_BLOCKS.due).element.initial_date_time).toBeUndefined();
  });

  it('sets initial_date_time in seconds, not milliseconds', () => {
    const due = new Date('2026-09-15T14:30:00Z');
    const el = block(view(task({ due_at: due })), EDIT_BLOCKS.due).element;
    expect(el.initial_date_time).toBe(Math.floor(due.getTime() / 1000));
    expect(el.initial_date_time).not.toBe(due.getTime());
  });

  it('omits the space initial_option when the task space is not in the list', () => {
    const el = block(view(task({ space_id: 's-missing' })), EDIT_BLOCKS.space).element;
    expect(el.initial_option).toBeUndefined();
  });
});

describe('optional inputs', () => {
  it('marks clearable fields optional and required ones not', () => {
    const v = view();
    expect(block(v, EDIT_BLOCKS.assignee).optional).toBe(true);
    expect(block(v, EDIT_BLOCKS.due).optional).toBe(true);
    expect(block(v, EDIT_BLOCKS.waitingOn).optional).toBe(true);
    expect(block(v, EDIT_BLOCKS.details).optional).toBe(true);
    expect(block(v, EDIT_BLOCKS.title).optional).toBeUndefined();
    expect(block(v, EDIT_BLOCKS.space).optional).toBeUndefined();
    expect(block(v, EDIT_BLOCKS.status).optional).toBeUndefined();
  });
});

describe('parseEditSubmission', () => {
  const submission = (over: Record<string, any> = {}) => ({
    private_metadata: JSON.stringify(meta),
    state: {
      values: {
        [EDIT_BLOCKS.title]: { title: { type: 'plain_text_input', value: 'New title' } },
        [EDIT_BLOCKS.space]: { space: { selected_option: { value: 's-nl' } } },
        [EDIT_BLOCKS.status]: { status: { selected_option: { value: 'waiting' } } },
        [EDIT_BLOCKS.assignee]: { assignee: { selected_user: 'U_JOSH' } },
        [EDIT_BLOCKS.due]: { due: { selected_date_time: 1_789_000_000 } },
        [EDIT_BLOCKS.waitingOn]: { waiting_on: { value: 'Neil' } },
        [EDIT_BLOCKS.details]: { details: { value: 'some notes' } },
        ...(over.values ?? {}),
      },
    },
    ...over,
  });

  it('maps every field', () => {
    const { meta: m, patch } = parseEditSubmission(submission());
    expect(m).toEqual(meta);
    expect(patch.title).toBe('New title');
    expect(patch.spaceId).toBe('s-nl');
    expect(patch.status).toBe('waiting');
    expect(patch.assigneeId).toBe('U_JOSH');
    expect(patch.dueAt?.getTime()).toBe(1_789_000_000 * 1000);
    expect(patch.waitingOn).toBe('Neil');
    expect(patch.details).toBe('some notes');
  });

  it('preserves a title byte-exact, including mrkdwn characters', () => {
    const { patch } = parseEditSubmission(submission({
      values: {
        [EDIT_BLOCKS.title]: {
          title: { value: 'Secure Logic — check-in with *Marty*’s team' },
        },
      },
    }));
    expect(patch.title).toBe('Secure Logic — check-in with *Marty*’s team');
  });

  it('treats cleared optional inputs as null, not empty string', () => {
    const { patch } = parseEditSubmission(submission({
      values: {
        [EDIT_BLOCKS.assignee]: { assignee: { selected_user: null } },
        [EDIT_BLOCKS.due]: { due: { selected_date_time: null } },
        [EDIT_BLOCKS.waitingOn]: { waiting_on: { value: null } },
        [EDIT_BLOCKS.details]: { details: { value: '' } },
      },
    }));
    expect(patch.assigneeId).toBeNull();
    expect(patch.dueAt).toBeNull();
    expect(patch.waitingOn).toBeNull();
    expect(patch.details).toBeNull();
  });

  it('reports a field error for a blank title instead of throwing', () => {
    for (const value of ['', '   ', null]) {
      const r = parseEditSubmission(submission({
        values: { [EDIT_BLOCKS.title]: { title: { value } } },
      }));
      expect(r.error?.blockId).toBe(EDIT_BLOCKS.title);
      expect(r.patch.title).toBeUndefined();
    }
  });

  it('survives malformed private_metadata without throwing', () => {
    const r = parseEditSubmission({ private_metadata: 'not json', state: { values: {} } });
    expect(r.meta.taskId).toBe('');
    expect(r.error).toBeDefined(); // no title either, so it reports a field error
  });

  it('survives a missing state object', () => {
    const r = parseEditSubmission({ private_metadata: JSON.stringify(meta) });
    expect(r.error?.blockId).toBe(EDIT_BLOCKS.title);
  });
});

describe('the card overflow', () => {
  const entry = (over: Partial<Task> = {}) => ({
    task: task(over),
    space: spaces[0]!,
  });
  const options = (t: Partial<Task> = {}) =>
    (taskControlBlocks(entry(t)) as any[])
      .flatMap((b) => b.elements)
      .flatMap((e: any) => e.options) as Array<{ text: { text: string }; value: string }>;

  it('offers Edit alongside the state change on an open task', () => {
    const o = options();
    expect(o.map((x) => x.value)).toEqual(['waiting:T1', 'edit:T1']);
    expect(o[1]!.text.text).toContain('Edit');
  });

  it('offers Edit on a waiting task too', () => {
    expect(options({ status: 'waiting' }).map((x) => x.value))
      .toEqual(['open:T1', 'edit:T1']);
  });

  it('offers nothing on a completed card, which stays checkbox-only', () => {
    expect(taskControlBlocks(entry({ status: 'completed', completed_at: new Date() })))
      .toEqual([]);
  });
});
