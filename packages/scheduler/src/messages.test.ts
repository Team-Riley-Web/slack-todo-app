import { describe, it, expect } from 'vitest';
import type { Space, Task, TaskGroup } from '@tr/task-core';
import { MAX_BLOCKS_PER_MESSAGE } from '@tr/slack-ui';
import { planTaskMessages, GROUP_CHUNK } from './messages.js';

const opts = { timeZone: 'America/Chicago' };

const space = (name: string): Space => ({
  id: `sp-${name}`, name, slug: name.toLowerCase(), is_inbox: false,
});

const task = (id: string, spaceId: string): Task => ({
  id, title: `Task ${id}`, space_id: spaceId, list_id: null, assignee_id: null,
  status: 'open', priority: null, due_at: null, waiting_on: null, details: null,
  created_at: new Date('2026-09-01T00:00:00Z'), completed_at: null,
  source_platform: 'slack', source_channel_id: null, source_message_ts: null,
  created_by: null, source_external_id: null, import_batch_id: null,
});

function group(name: string, count: number): TaskGroup {
  const s = space(name);
  return {
    heading: name.toUpperCase(),
    entries: Array.from({ length: count }, (_, i) => ({
      task: task(`${name}-${i}`, s.id), space: s,
    })),
  };
}

const totalEntries = (groups: TaskGroup[]) =>
  groups.reduce((n, g) => n + g.entries.length, 0);

describe('the daily digest layout', () => {
  it('puts the heading on the message and the tasks under it', () => {
    const [message, ...rest] = planTaskMessages(
      'Agency Tasks — Today', [group('marketing', 3)], opts
    );
    expect(rest).toHaveLength(0);
    expect(message!.blocks[0]).toMatchObject({
      type: 'header', text: { text: 'Agency Tasks — Today' },
    });
    expect(message!.entries).toHaveLength(3);
    expect(message!.text).toContain('[ ] Task marketing-0');
  });

  it('renders native checkboxes, the same control a /tasks card carries', () => {
    const [message] = planTaskMessages('Agency Tasks — Today', [group('sales', 2)], opts);
    const actions = message!.blocks.filter((b) => (b as { type: string }).type === 'actions');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      elements: [{ type: 'checkboxes', action_id: 'task_checkbox' }],
    });
  });

  it('says so plainly when nothing is open', () => {
    const [message, ...rest] = planTaskMessages('Personal Tasks — Today', [], opts);
    expect(rest).toHaveLength(0);
    expect(message!.entries).toEqual([]);
    expect(message!.text).toContain('Nothing open.');
  });

  it('keeps every message inside Slack’s 50-block limit', () => {
    const groups = Array.from({ length: 12 }, (_, i) => group(`space${i}`, 40));
    for (const message of planTaskMessages('Agency Tasks — Today', groups, opts)) {
      expect(message.blocks.length).toBeLessThanOrEqual(MAX_BLOCKS_PER_MESSAGE);
    }
  });

  it('leaves room for the digest header on the first message too', async () => {
    // Sized so the packer fills a message: the first one must still fit once
    // its own header block is added on top of the groups.
    const groups = Array.from({ length: 20 }, (_, i) => group(`space${i}`, 30));
    const [first, ...rest] = planTaskMessages('Agency Tasks — Today', groups, opts);
    expect(rest.length).toBeGreaterThan(0);
    expect(first!.blocks[0]).toMatchObject({ type: 'header' });
    expect(first!.blocks.length).toBeLessThanOrEqual(MAX_BLOCKS_PER_MESSAGE);
  });

  /**
   * The requirement the whole packer exists for. `/tasks all` drops whole
   * Spaces past 50 blocks and leaves a note; a digest that did the same would
   * quietly stop telling you about your client work.
   */
  it('shows every task, across as many messages as that takes', () => {
    const groups = Array.from({ length: 12 }, (_, i) => group(`space${i}`, 40));
    const messages = planTaskMessages('Agency Tasks — Today', groups, opts);

    expect(messages.length).toBeGreaterThan(1);
    const delivered = messages.flatMap((m) => m.entries).map((e) => e.task.id);
    expect(delivered).toHaveLength(totalEntries(groups));
    expect(new Set(delivered).size).toBe(totalEntries(groups));
  });

  it('never leaves a "more Spaces not shown" note in place of real tasks', () => {
    const groups = Array.from({ length: 12 }, (_, i) => group(`space${i}`, 40));
    for (const message of planTaskMessages('Agency Tasks — Today', groups, opts)) {
      expect(JSON.stringify(message.blocks)).not.toContain('not shown');
    }
  });

  it('continues a Space too large for one heading rather than truncating it', () => {
    const messages = planTaskMessages(
      'Agency Tasks — Today', [group('inbox', GROUP_CHUNK * 2 + 5)], opts
    );
    const delivered = messages.flatMap((m) => m.entries);
    expect(delivered).toHaveLength(GROUP_CHUNK * 2 + 5);
    expect(JSON.stringify(messages.map((m) => m.blocks))).toContain('INBOX (CONT.)');
  });

  it('only the first message carries the digest heading', () => {
    const groups = Array.from({ length: 12 }, (_, i) => group(`space${i}`, 40));
    const messages = planTaskMessages('Agency Tasks — Today', groups, opts);
    expect(messages[0]!.text).toContain('Agency Tasks — Today');
    expect(messages[1]!.text).toContain('(continued)');
  });
});
