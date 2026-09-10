import { describe, it, expect } from 'vitest';
import { truncateLabel, metaLine, LABEL_BUDGET } from './label.js';
import type { Task, Space } from '@tr/task-core';

const space = (name: string): Space => ({ id: 's', name, slug: 'x', is_inbox: false });

const task = (over: Partial<Task> = {}): Task => ({
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Call Neil', space_id: 's', list_id: null, assignee_id: null,
  status: 'open', due_at: null, waiting_on: null, created_at: new Date(),
  completed_at: null, source_platform: 'slack', source_channel_id: null,
  source_message_ts: null, created_by: null, ...over,
});

const opts = { timeZone: 'America/Chicago', assigneeLabels: { U_JOSH: 'Joshua' } };

describe('truncateLabel', () => {
  it('leaves a short title untouched', () => {
    expect(truncateLabel('Call Neil')).toEqual({ label: 'Call Neil', truncated: false });
  });

  it('leaves a title of exactly the budget untouched', () => {
    const t = 'x'.repeat(LABEL_BUDGET);
    expect(truncateLabel(t)).toEqual({ label: t, truncated: false });
  });

  it('truncates one char over the budget and flags it', () => {
    const r = truncateLabel('x'.repeat(LABEL_BUDGET + 1));
    expect(r.truncated).toBe(true);
    expect([...r.label]).toHaveLength(LABEL_BUDGET + 1);
    expect(r.label.endsWith('…')).toBe(true);
  });

  it('keeps the strikethrough form within Slack 75-char option cap', () => {
    const r = truncateLabel('y'.repeat(400));
    expect([...`~${r.label}~`]).toHaveLength(75);
  });

  it('counts code points, not UTF-16 units, for astral characters', () => {
    const r = truncateLabel('🙂'.repeat(100));
    expect([...r.label]).toHaveLength(LABEL_BUDGET + 1);
    expect(r.label.slice(0, -1)).toBe('🙂'.repeat(LABEL_BUDGET));
    expect(r.label).not.toContain('�');
    expect(Array.from(r.label).every((c) => c === '🙂' || c === '…')).toBe(true);
  });

  it('preserves the curly apostrophes and em dashes present in real data', () => {
    for (const t of [
      'Waiting on Milltown’s reply to the email proposal',
      'Secure Logic — three-month honeymoon check-in with Marty',
    ]) {
      expect(truncateLabel(t)).toEqual({ label: t, truncated: false });
    }
  });
});

describe('metaLine', () => {
  it('renders space, assignee, and due date for an open task', () => {
    const line = metaLine(
      task({ assignee_id: 'U_JOSH', due_at: new Date('2026-09-15T05:00:00Z') }),
      space('Client - Nazareth Law'), opts
    );
    expect(line).toBe('Nazareth Law · Joshua · due Sep 15');
  });

  it('renders completion for a completed task and drops due/assignee', () => {
    const line = metaLine(
      task({
        status: 'completed', assignee_id: 'U_JOSH',
        completed_at: new Date('2026-09-09T18:00:00Z'),
      }),
      space('Client - Nazareth Law'), opts
    );
    expect(line).toBe('Completed Sep 9 · Nazareth Law');
  });

  it('renders waiting_on when present and bare waiting when not', () => {
    expect(metaLine(task({ status: 'waiting', waiting_on: 'Neil' }), space('Sales'), opts))
      .toBe('Sales · waiting on Neil');
    expect(metaLine(task({ status: 'waiting' }), space('Sales'), opts))
      .toBe('Sales · waiting');
  });

  it('omits an assignee with no configured label rather than showing a raw ID', () => {
    expect(metaLine(task({ assignee_id: 'U_NOBODY' }), space('Sales'), opts)).toBe('Sales');
  });

  it('never exceeds Slack 75-char description cap', () => {
    const line = metaLine(
      task({
        status: 'waiting', assignee_id: 'U_JOSH',
        waiting_on: 'a very long explanation '.repeat(10),
      }),
      space('Client - Milltown Cabinets'), opts
    );
    expect([...line].length).toBeLessThanOrEqual(75);
  });
});
