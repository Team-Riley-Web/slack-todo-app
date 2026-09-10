import { describe, it, expect } from 'vitest';
import { slackDate, slackUser, metaLine } from './label.js';
import {
  headerBlock, confirmObject, summaryBlocks, taskListBlocks, taskCardBlocks,
} from './card.js';
import type { Task, Space } from '@tr/task-core';

const space: Space = { id: 's', name: 'Client - Nazareth Law', slug: 'nl', is_inbox: false };
const opts = { timeZone: 'America/Chicago', assigneeLabels: { U_JOSH: 'Joshua' } };
const task = (over: Partial<Task> = {}): Task => ({
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Call Neil', space_id: 's', list_id: null, assignee_id: null,
  status: 'open', due_at: null, waiting_on: null, details: null, created_at: new Date(),
  completed_at: null, source_platform: 'slack', source_channel_id: null,
  source_message_ts: null, created_by: null, ...over,
});

describe('native date token', () => {
  it('emits unix seconds, the token, and a non-empty fallback', () => {
    const out = slackDate(new Date('2026-09-15T05:00:00Z'), '{date_short}', 'America/Chicago');
    const m = /^<!date\^(\d+)\^\{date_short\}\|(.+)>$/.exec(out);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(Math.floor(Date.parse('2026-09-15T05:00:00Z') / 1000));
    expect(m![2]!.length).toBeGreaterThan(0);
  });

  it('uses seconds, not milliseconds', () => {
    const d = new Date('2026-09-15T05:00:00Z');
    expect(slackDate(d)).not.toContain(String(d.getTime()));
  });

  it('accepts any token', () => {
    expect(slackDate(new Date(0), '{date_pretty}')).toContain('{date_pretty}');
  });
});

describe('native user mention', () => {
  it('wraps a user id', () => {
    expect(slackUser('U_JOSH')).toBe('<@U_JOSH>');
  });

  it('returns null for no assignee rather than an empty mention', () => {
    expect(slackUser(null)).toBeNull();
    expect(slackUser(undefined)).toBeNull();
    expect(slackUser('')).toBeNull();
  });
});

describe('the plain_text constraint on the checkbox description', () => {
  // option.description is typed PlainTextElement, so the native tokens would
  // render as literal source there. This asserts we never leak one in.
  it('never puts a date token or a mention in the meta line', () => {
    const line = metaLine(
      task({
        assignee_id: 'U_JOSH', due_at: new Date('2026-09-15T05:00:00Z'),
      }),
      space, opts
    );
    expect(line).not.toContain('<!date^');
    expect(line).not.toContain('<@');
    expect(line).toBe('Nazareth Law · Joshua · due Sep 15');
  });

  it('keeps the card free of native tokens for the same reason', () => {
    const blocks = taskCardBlocks([{
      task: task({ assignee_id: 'U_JOSH', due_at: new Date('2026-09-15T05:00:00Z') }),
      space,
    }], opts);
    const json = JSON.stringify(blocks);
    expect(json).not.toContain('<!date^');
    expect(json).not.toContain('<@U_JOSH>');
  });
});

describe('native header block', () => {
  it('is a real header, not bold text in a section', () => {
    const b = headerBlock('MARKETING') as any;
    expect(b.type).toBe('header');
    expect(b.text.type).toBe('plain_text');
    expect(b.text.text).toBe('MARKETING');
  });

  it('caps at Slack 150-char limit', () => {
    expect(((headerBlock('x'.repeat(400)) as any).text.text as string).length).toBe(150);
  });

  it('is what taskListBlocks uses for a heading', () => {
    const blocks = taskListBlocks(
      [{ heading: 'MARKETING', entries: [{ task: task(), space }] }], opts
    ) as any[];
    expect(blocks[0].type).toBe('header');
    const bolded = blocks.filter(
      (b) => b.type === 'section' && typeof b.text?.text === 'string' && b.text.text === '*MARKETING*'
    );
    expect(bolded).toEqual([]);
  });
});

describe('native section fields for the summary', () => {
  const counts = [
    { space_name: 'Agency / Internal', open: 4, waiting: 0 },
    { space_name: 'Client - Secure Logic', open: 2, waiting: 1 },
  ];

  it('emits a header plus a section carrying a fields array', () => {
    const blocks = summaryBlocks(counts) as any[];
    expect(blocks[0].type).toBe('header');
    expect(blocks[1].type).toBe('section');
    expect(Array.isArray(blocks[1].fields)).toBe(true);
    expect(blocks[1].fields).toHaveLength(2);
  });

  it('strips the client prefix and reports waiting only when present', () => {
    const fields = (summaryBlocks(counts) as any[])[1].fields as Array<{ text: string }>;
    expect(fields[0]!.text).toContain('Agency / Internal');
    expect(fields[0]!.text).not.toContain('waiting');
    expect(fields[1]!.text).toContain('Secure Logic');
    expect(fields[1]!.text).not.toContain('Client - Secure Logic');
    expect(fields[1]!.text).toContain('1 waiting');
  });

  it('chunks past Slack 10-field cap instead of overflowing one section', () => {
    const many = Array.from({ length: 23 }, (_, i) => ({
      space_name: `S${i}`, open: 1, waiting: 0,
    }));
    const sections = (summaryBlocks(many) as any[]).filter((b) => b.type === 'section');
    expect(sections.map((s) => s.fields.length)).toEqual([10, 10, 3]);
  });

  it('handles an empty summary without an empty fields array', () => {
    const blocks = summaryBlocks([]) as any[];
    expect(blocks[0].type).toBe('header');
    expect(blocks[1].fields).toBeUndefined();
    expect(blocks[1].text.text).toContain('Nothing open');
  });
});

describe('native confirm dialog', () => {
  it('is well formed and styled danger', () => {
    const c = confirmObject('Roll back import', 'Deletes 21 tasks. Cannot be undone.') as any;
    expect(c.title.type).toBe('plain_text');
    expect(c.text.text).toContain('Cannot be undone');
    expect(c.confirm.text).toBeTruthy();
    expect(c.deny.text).toBeTruthy();
    expect(c.style).toBe('danger');
  });

  it('caps title and text at Slack limits', () => {
    const c = confirmObject('t'.repeat(300), 'x'.repeat(900)) as any;
    expect(c.title.text.length).toBe(100);
    expect(c.text.text.length).toBe(300);
  });
});
