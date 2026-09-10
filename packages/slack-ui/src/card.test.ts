import { describe, it, expect } from 'vitest';
import {
  taskCardBlocks, taskCardFallback, taskListBlocks, taskControlBlocks,
  CHECKBOX_ACTION_ID,
} from './card.js';
import type { Task, Space } from '@tr/task-core';

const space: Space = { id: 's', name: 'Client - Nazareth Law', slug: 'nl', is_inbox: false };
const opts = { timeZone: 'America/Chicago', assigneeLabels: { U_JOSH: 'Joshua' } };

const task = (over: Partial<Task> = {}): Task => ({
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Offer Neil Instagram and Facebook package for $100',
  space_id: 's', list_id: null, assignee_id: 'U_JOSH', status: 'open',
  due_at: null, waiting_on: null, details: null, created_at: new Date(), completed_at: null,
  source_platform: 'slack', source_channel_id: null, source_message_ts: null,
  created_by: null, source_external_id: null, import_batch_id: null, ...over,
});

const checkbox = (blocks: any[]) => blocks.find((b) => b.type === 'actions').elements[0];

describe('open task card', () => {
  it('uses a native checkboxes element inside an actions block', () => {
    const el = checkbox(taskCardBlocks([{ task: task(), space }], opts));
    expect(el.type).toBe('checkboxes');
    expect(el.action_id).toBe(CHECKBOX_ACTION_ID);
    expect(el.options).toHaveLength(1);
  });

  it('renders the title as plain_text so mrkdwn characters stay literal', () => {
    const el = checkbox(taskCardBlocks([{ task: task({ title: 'fix *urgent* bug' }), space }], opts));
    expect(el.options[0].text).toEqual({
      type: 'plain_text', text: 'fix *urgent* bug', emoji: true,
    });
  });

  it('carries the bare task UUID as the option value', () => {
    const el = checkbox(taskCardBlocks([{ task: task(), space }], opts));
    expect(el.options[0].value).toBe('11111111-1111-4111-8111-111111111111');
    expect([...el.options[0].value].length).toBeLessThanOrEqual(75);
  });

  it('omits initial_options entirely when nothing is complete', () => {
    const el = checkbox(taskCardBlocks([{ task: task(), space }], opts));
    expect(el.initial_options).toBeUndefined();
  });

  it('sets a plain_text description with the meta line', () => {
    const el = checkbox(taskCardBlocks([{ task: task(), space }], opts));
    expect(el.options[0].description.type).toBe('plain_text');
    expect(el.options[0].description.text).toBe('Nazareth Law · Joshua');
  });

  it('keeps every option label within Slack 75-char cap', () => {
    const el = checkbox(taskCardBlocks([{ task: task(), space }], opts));
    expect([...el.options[0].text.text].length).toBeLessThanOrEqual(75);
  });
});

describe('completed task card', () => {
  const done = task({ status: 'completed', completed_at: new Date('2026-09-09T18:00:00Z') });

  it('renders mrkdwn strikethrough with verbatim set', () => {
    const el = checkbox(taskCardBlocks([{ task: done, space }], opts));
    expect(el.options[0].text).toEqual({
      type: 'mrkdwn',
      text: '~Offer Neil Instagram and Facebook package for $100~',
      verbatim: true,
    });
  });

  it('marks the checkbox selected', () => {
    const el = checkbox(taskCardBlocks([{ task: done, space }], opts));
    expect(el.initial_options).toHaveLength(1);
    expect(el.initial_options[0].value).toBe(done.id);
  });

  // The initial_options bug trap - spec section 4
  it('places the SAME object reference in options and initial_options', () => {
    const el = checkbox(taskCardBlocks([{ task: done, space }], opts));
    expect(el.initial_options[0]).toBe(el.options[0]);
    expect(el.initial_options[0]).toEqual(el.options[0]);
  });

  it('keeps the checkbox interactive so unchecking can reopen', () => {
    const blocks = taskCardBlocks([{ task: done, space }], opts);
    const el = checkbox(blocks);
    expect(el.action_id).toBe(CHECKBOX_ACTION_ID);
    expect(JSON.stringify(blocks).match(/"type":"button"/g)).toBeNull();
  });

  it('states completion in the description as a strikethrough-independent signal', () => {
    const el = checkbox(taskCardBlocks([{ task: done, space }], opts));
    expect(el.options[0].description.text).toBe('Completed Sep 9 · Nazareth Law');
  });
});

describe('mixed group', () => {
  const a = task({ id: '11111111-1111-4111-8111-111111111111', title: 'Meditate' });
  const b = task({
    id: '22222222-2222-4222-8222-222222222222', title: 'Exercise',
    status: 'completed', completed_at: new Date('2026-09-09T18:00:00Z'),
  });
  const c = task({ id: '33333333-3333-4333-8333-333333333333', title: 'Journal' });

  it('selects only the completed entries, by reference', () => {
    const el = checkbox(taskCardBlocks(
      [{ task: a, space }, { task: b, space }, { task: c, space }], opts
    ));
    expect(el.options).toHaveLength(3);
    expect(el.initial_options).toHaveLength(1);
    expect(el.initial_options[0]).toBe(el.options[1]);
  });

  it('splits into multiple elements beyond Slack 10-option cap', () => {
    const entries = Array.from({ length: 23 }, (_, i) => ({
      task: task({ id: `${i}`.padStart(8, '0') + '-1111-4111-8111-111111111111', title: `T${i}` }),
      space,
    }));
    const blocks = taskCardBlocks(entries, opts);
    const groups = blocks.filter((b: any) => b.type === 'actions');
    expect(groups.map((g: any) => g.elements[0].options.length)).toEqual([10, 10, 3]);
    const ids = new Set(groups.map((g: any) => g.block_id));
    expect(ids.size).toBe(3);
  });
});

describe('truncated title', () => {
  const long = task({ title: 'L'.repeat(200) });

  it('adds a context block carrying the full exact title', () => {
    const blocks = taskCardBlocks([{ task: long, space }], opts);
    const ctx = blocks.find((b: any) => b.type === 'context') as any;
    expect(ctx.elements[0].text).toContain('L'.repeat(200));
  });

  it('does not add a context block when nothing is truncated', () => {
    const blocks = taskCardBlocks([{ task: task(), space }], opts);
    expect(blocks.find((b: any) => b.type === 'context')).toBeUndefined();
  });

  it('never mutates the task title while rendering', () => {
    const t = task({ title: 'M'.repeat(200) });
    const before = t.title;
    taskCardBlocks([{ task: t, space }], opts);
    expect(t.title).toBe(before);
  });
});

describe('waiting overflow', () => {
  const overflows = (blocks: any[]) =>
    blocks.filter((b) => b.type === 'actions')
      .flatMap((b: any) => b.elements)
      .filter((e: any) => e.type === 'overflow');

  it('offers Move to Waiting on a single open task card', () => {
    const o = overflows(taskCardBlocks([{ task: task(), space }], opts));
    expect(o).toHaveLength(1);
    expect(o[0].options[0].text.text).toBe('Move to Waiting');
    expect(o[0].options[0].value).toBe(`waiting:${task().id}`);
  });

  it('offers Move to Open on a waiting task', () => {
    const o = overflows(taskCardBlocks([{ task: task({ status: 'waiting' }), space }], opts));
    expect(o[0].options[0].text.text).toBe('Move to Open');
  });

  it('offers no overflow on a completed task, leaving only the checkbox', () => {
    const done = task({ status: 'completed', completed_at: new Date() });
    expect(overflows(taskCardBlocks([{ task: done, space }], opts))).toHaveLength(0);
  });

  it('offers no overflow in a multi-task list, keeping list views uncluttered', () => {
    const b = task({ id: '22222222-2222-4222-8222-222222222222', title: 'Exercise' });
    expect(overflows(taskCardBlocks([{ task: task(), space }, { task: b, space }], opts)))
      .toHaveLength(0);
  });

  it('never offers a Reopen control, since unchecking is the reopen gesture', () => {
    const done = task({ status: 'completed', completed_at: new Date() });
    for (const t of [task(), task({ status: 'waiting' }), done]) {
      const json = JSON.stringify(taskCardBlocks([{ task: t, space }], opts));
      expect(json.toLowerCase()).not.toContain('reopen');
    }
  });
});

// Regression: ISSUE-004 — an empty card produced empty fallback text, and
// chat.update with no text and no blocks is rejected by Slack.
// Found by /qa on 2026-09-09
// Report: .gstack/qa-reports/qa-report-team-riley-tasks-2026-09-09.md
describe('empty card', () => {
  it('never produces empty fallback text', () => {
    expect(taskCardFallback([]).length).toBeGreaterThan(0);
  });

  it('still lists titles when entries are present', () => {
    expect(taskCardFallback([{ task: task(), space }])).toContain('Offer Neil');
  });
});

// Regression: ISSUE-006 — 500 tasks rendered 51 blocks and Slack rejects any
// message over 50, so a full `/tasks <space>` post failed outright.
// Found by /qa on 2026-09-09
// Report: .gstack/qa-reports/qa-report-team-riley-tasks-2026-09-09.md
describe('Slack 50-block message limit', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      task: task({
        id: `${i}`.padStart(8, '0') + '-1111-4111-8111-111111111111',
        title: `Task ${i}`,
      }),
      space,
    }));

  it('stays within 50 blocks at the query limit, heading included', () => {
    const blocks = taskListBlocks([{ heading: 'MARKETING', entries: many(500) }], opts);
    expect(blocks.length).toBeLessThanOrEqual(50);
  });

  it('stays within 50 blocks for an absurd number of entries', () => {
    for (const n of [401, 500, 1000, 5000]) {
      expect(taskListBlocks([{ heading: 'X', entries: many(n) }], opts).length)
        .toBeLessThanOrEqual(50);
    }
  });

  it('reports the overflow rather than silently dropping tasks', () => {
    const blocks = taskCardBlocks(many(450), opts);
    const ctx = blocks.filter((b: any) => b.type === 'context');
    expect(JSON.stringify(ctx)).toContain('Showing 400 of 450');
    expect(JSON.stringify(ctx)).toContain('50 more not shown');
  });

  it('adds no overflow note when everything fits', () => {
    const blocks = taskCardBlocks(many(12), opts);
    expect(JSON.stringify(blocks)).not.toContain('not shown');
  });
});


// --- control placement ---

describe('where the overflow menu sits', () => {
  const actionsOf = (blocks: any[]) => blocks.filter((b: any) => b.type === 'actions');

  it('puts the overflow in the same actions block as the checkbox', () => {
    // It used to be its own actions block underneath, which Slack rendered as
    // a stray button separated by a large vertical gap. An actions block lays
    // its elements out in a row, so sharing the block puts the menu to the
    // right of the task.
    const actions = actionsOf(taskCardBlocks([{ task: task(), space }], opts));
    expect(actions).toHaveLength(1);
    expect(actions[0].elements.map((e: any) => e.type))
      .toEqual(['checkboxes', 'overflow']);
  });

  it('keeps the checkbox first, so it stays on the left', () => {
    const actions = actionsOf(taskCardBlocks([{ task: task(), space }], opts));
    expect(actions[0].elements[0].type).toBe('checkboxes');
  });

  it('keeps the versioned block_id on the shared block', () => {
    // The checkbox handler matches a payload to the render it came from
    // through this id, so merging the blocks must not disturb it.
    const actions = actionsOf(
      taskCardBlocks([{ task: task(), space }], { ...opts, version: 4 })
    );
    expect(actions[0].block_id).toBe('task_toggle:0:v4');
  });

  it('gives a completed single task a checkbox and no overflow', () => {
    const actions = actionsOf(taskCardBlocks(
      [{ task: task({ status: 'completed', completed_at: new Date() }), space }], opts
    ));
    expect(actions[0].elements.map((e: any) => e.type)).toEqual(['checkboxes']);
  });

  it('adds no overflow to a multi-task card, since one menu cannot target one task', () => {
    const actions = actionsOf(taskCardBlocks(
      [{ task: task(), space }, { task: task({ id: '22222222-2222-4222-8222-222222222222' }), space }],
      opts
    ));
    expect(actions.flatMap((b: any) => b.elements.map((e: any) => e.type)))
      .toEqual(['checkboxes']);
  });

  it('still exposes the overflow as a standalone block for other callers', () => {
    const blocks = taskControlBlocks({ task: task(), space }) as any[];
    expect(blocks[0].type).toBe('actions');
    expect(blocks[0].elements[0].type).toBe('overflow');
  });
});
