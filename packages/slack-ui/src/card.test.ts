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
  space_id: 's', list_id: null, assignee_id: 'U_JOSH', status: 'open', priority: null,
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
    expect(el.options[0].description.text).toBe('Nazareth Law');
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

  it('carries no "Completed" line — the checked box and strikethrough say it', () => {
    const el = checkbox(taskCardBlocks([{ task: done, space }], opts));
    expect(el.options[0].description.text).toBe('Nazareth Law');
    expect(el.options[0].description.text).not.toMatch(/Completed/);
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

  it('offers Move to Waiting for an open task', () => {
    // taskControlBlocks is retained for cards posted before the controls moved
    // into Slack's "More actions" menu; those messages still carry an overflow
    // and it must keep working.
    const o = overflows(taskControlBlocks({ task: task(), space }) as any[]);
    expect(o).toHaveLength(1);
    expect(o[0].options[0].text.text).toBe('Move to Waiting');
    expect(o[0].options[0].value).toBe(`waiting:${task().id}`);
  });

  it('offers Move to Open on a waiting task', () => {
    const o = overflows(taskControlBlocks({ task: task({ status: 'waiting' }), space }) as any[]);
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

  it('carries no control of its own: the checkbox is the whole card', () => {
    // Move to Waiting and Edit task live in Slack's own "More actions" menu as
    // message shortcuts now. An overflow beside the task or below it was
    // clutter either way.
    const actions = actionsOf(taskCardBlocks([{ task: task(), space }], opts));
    expect(actions).toHaveLength(1);
    expect(actions[0].elements.map((e: any) => e.type)).toEqual(['checkboxes']);
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

// --- block_id uniqueness across groups ---

describe('a list covering several Spaces', () => {
  const group = (heading: string, n: number, seed: string) => ({
    heading,
    entries: Array.from({ length: n }, (_, i) => ({
      task: task({ id: `${seed}${i}`.padEnd(36, '0'), title: `${heading} ${i}` }),
      space,
    })),
  });

  it('gives every block a unique block_id', () => {
    // The bug this pins: each group restarted its counter at 0, so seven
    // Spaces all emitted task_toggle:0:v1 and Slack rejected the entire
    // message with `invalid_blocks ... already exists`. Nothing rendered.
    const groups = ['AGENCY', 'MARKETING', 'MUSIC', 'PERSONAL', 'SALES', 'INBOX', 'MILLTOWN']
      .map((h, i) => group(h, 3, String(i)));
    const blocks = taskListBlocks(groups, opts) as any[];

    const ids = blocks.map((b) => b.block_id).filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('numbers the ids consecutively across groups', () => {
    const groups = [group('A', 2, 'a'), group('B', 2, 'b'), group('C', 2, 'c')];
    const ids = (taskListBlocks(groups, opts) as any[])
      .map((b) => b.block_id).filter(Boolean);
    expect(ids).toEqual(['task_toggle:0:v1', 'task_toggle:1:v1', 'task_toggle:2:v1']);
  });

  it('keeps ids unique when a Space needs more than one checkbox element', () => {
    // 12 entries is two chunks of ten, so the offset must advance by two.
    const groups = [group('BIG', 12, 'x'), group('SMALL', 1, 'y')];
    const ids = (taskListBlocks(groups, opts) as any[])
      .map((b) => b.block_id).filter(Boolean);
    expect(ids).toEqual(['task_toggle:0:v1', 'task_toggle:1:v1', 'task_toggle:2:v1']);
    expect(new Set(ids).size).toBe(3);
  });

  it('carries the render version into every group', () => {
    const groups = [group('A', 1, 'a'), group('B', 1, 'b')];
    const ids = (taskListBlocks(groups, { ...opts, version: 7 }) as any[])
      .map((b) => b.block_id).filter(Boolean);
    expect(ids).toEqual(['task_toggle:0:v7', 'task_toggle:1:v7']);
  });

  it('stays within Slack 50-block limit and says what it left out', () => {
    const groups = Array.from({ length: 40 }, (_, i) => group(`S${i}`, 2, `s${i}`));
    const blocks = taskListBlocks(groups, opts) as any[];
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(blocks)).toContain('not shown');
  });

  it('skips an empty group without consuming a block_id', () => {
    const groups = [group('A', 1, 'a'), { heading: 'EMPTY', entries: [] }, group('B', 1, 'b')];
    const ids = (taskListBlocks(groups, opts) as any[])
      .map((b) => b.block_id).filter(Boolean);
    expect(ids).toEqual(['task_toggle:0:v1', 'task_toggle:1:v1']);
    expect(JSON.stringify(blocks(groups))).not.toContain('EMPTY');
  });
});

function blocks(groups: any[]) {
  return taskListBlocks(groups, { timeZone: 'America/Chicago', assigneeLabels: {} });
}

// --- noise under a Space heading ---

describe('a grouped list', () => {
  const grp = (heading: string, titles: string[]) => ({
    heading,
    entries: titles.map((title, i) => ({
      task: task({ id: `${heading}${i}`.padEnd(36, '0'), title, assignee_id: 'U_JOSH' }),
      space: { id: 's', name: heading, slug: heading, is_inbox: false } as any,
    })),
  });

  const descriptions = (blocks: any[]) =>
    blocks.filter((b) => b.type === 'actions')
      .flatMap((b: any) => b.elements[0].options)
      .map((o: any) => o.description?.text);

  it('does not repeat the Space on every row beneath its heading', () => {
    const blocks = taskListBlocks([grp('MARKETING', ['a', 'b', 'c'])], opts) as any[];
    for (const d of descriptions(blocks)) {
      expect(d ?? '').not.toContain('MARKETING');
    }
  });

  it('never shows the assignee, grouped or not', () => {
    const grouped = taskListBlocks([grp('MARKETING', ['a'])], opts) as any[];
    const flat = taskCardBlocks(
      [{ task: task({ assignee_id: 'U_JOSH' }), space }], opts
    ) as any[];
    expect(JSON.stringify(grouped)).not.toContain('Joshua');
    expect(JSON.stringify(flat)).not.toContain('Joshua');
  });

  it('drops the description entirely when nothing is left to say', () => {
    // Open, no due date, Space named by the heading above: no second line.
    const blocks = taskListBlocks([grp('MUSIC', ['Get and make new merch'])], opts) as any[];
    const option = blocks.find((b) => b.type === 'actions').elements[0].options[0];
    expect(option.description).toBeUndefined();
  });

  it('still shows a due date under a heading, because that is not noise', () => {
    const group = grp('SECURE LOGIC', ['check-in']);
    group.entries[0]!.task.due_at = new Date('2026-11-13T06:00:00Z');
    const blocks = taskListBlocks([group], opts) as any[];
    const option = blocks.find((b) => b.type === 'actions').elements[0].options[0];
    expect(option.description.text).toContain('due Nov 13');
  });

  it('keeps the Space on a flat card, where no heading names it', () => {
    const blocks = taskCardBlocks([{ task: task(), space }], opts) as any[];
    const option = blocks.find((b) => b.type === 'actions').elements[0].options[0];
    expect(option.description.text).toBe('Nazareth Law');
  });
});

// --- priority on the row, 2026-09-11 ---

describe('priority in a rendered task', () => {
  const opts = { timeZone: 'America/Chicago' };

  it('tags the label, keeping the native checkbox', () => {
    const el = checkbox(taskCardBlocks(
      [{ task: task({ title: 'Fix Stripe checkout', priority: 'P0' }), space }], opts
    ));
    expect(el.options[0].text.text).toBe('[P0] Fix Stripe checkout');
    expect(el.action_id).toBe('task_checkbox');
    expect(el.type).toBe('checkboxes');
  });

  it('shows nothing at all for an unprioritized task', () => {
    const el = checkbox(taskCardBlocks(
      [{ task: task({ title: 'Update footer links' }), space }], opts
    ));
    expect(el.options[0].text.text).toBe('Update footer links');
  });

  it('renders the example list from the brief', () => {
    const el = checkbox(taskCardBlocks([
      { task: task({ id: 'a', title: 'Fix Stripe checkout', priority: 'P0' }), space },
      { task: task({ id: 'b', title: 'Finish client homepage', priority: 'P1' }), space },
      { task: task({ id: 'c', title: 'Update footer links' }), space },
    ], opts));
    expect(el.options.map((o: any) => o.text.text)).toEqual([
      '[P0] Fix Stripe checkout',
      '[P1] Finish client homepage',
      'Update footer links',
    ]);
  });

  it('keeps a completed task readable as a priority, striking only the title', () => {
    const el = checkbox(taskCardBlocks(
      [{ task: task({ title: 'Done thing', priority: 'P2', status: 'completed' }), space }],
      opts
    ));
    expect(el.options[0].text.text).toBe('[P2] ~Done thing~');
  });

  /**
   * Slack rejects the entire message if an option label runs past 75
   * characters, so the tag has to come out of the title's allowance rather
   * than be added on top of it.
   */
  it('never lets the tag push a label past Slack’s 75-character limit', () => {
    const long = 'x'.repeat(200);
    for (const priority of [null, 'P0'] as const) {
      const el = checkbox(taskCardBlocks(
        [{ task: task({ title: long, priority }), space }], opts
      ));
      expect([...el.options[0].text.text].length).toBeLessThanOrEqual(75);
    }
  });

  it('still offers the full title when the tag caused the clipping', () => {
    const long = 'y'.repeat(70);
    const blocks = taskCardBlocks(
      [{ task: task({ title: long, priority: 'P0' }), space }], opts
    );
    // 70 chars fits alone but not once "[P0] " takes five of the budget.
    expect(JSON.stringify(blocks)).toContain(`Full title: ${long}`);
  });

  it('carries the tag into the notification fallback too', () => {
    expect(taskCardFallback([
      { task: task({ id: 'a', title: 'Fix Stripe checkout', priority: 'P0' }), space },
      { task: task({ id: 'b', title: 'Update footer links' }), space },
    ])).toBe('[ ] [P0] Fix Stripe checkout\n[ ] Update footer links');
  });
});
