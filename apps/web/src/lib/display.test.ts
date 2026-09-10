import { describe, it, expect } from 'vitest';
import {
  dueLabel, ageInDays, ageLabel, taskEditHref, closeEditHref, isClientSpace,
  spaceHref, filterHref, shortSpaceName,
} from './display.js';
import type { Task, Space } from '@tr/task-core';

const NOW = new Date('2026-09-10T12:00:00Z');

const task = (over: Partial<Task> = {}): Task => ({
  id: 'T1', title: 'Call Neil', space_id: 'S1', list_id: null, assignee_id: null,
  status: 'open', due_at: null, waiting_on: null, details: null,
  created_at: new Date('2026-09-10T09:00:00Z'), completed_at: null,
  source_platform: 'web', source_channel_id: null, source_message_ts: null,
  created_by: null, source_external_id: null, import_batch_id: null, ...over,
});

const space: Space = {
  id: 'S1', name: 'Client - Nazareth Law', slug: 'nazareth-law', is_inbox: false,
};

describe('dueLabel', () => {
  it('returns null with no due date', () => {
    expect(dueLabel(task(), NOW)).toBeNull();
  });

  it('reads relatively for today and tomorrow', () => {
    expect(dueLabel(task({ due_at: new Date('2026-09-10T23:00:00Z') }), NOW))
      .toEqual({ text: 'Due today', tone: 'soon' });
    expect(dueLabel(task({ due_at: new Date('2026-09-11T01:00:00Z') }), NOW))
      .toEqual({ text: 'Due tomorrow', tone: 'soon' });
  });

  it('counts calendar days, so a time of day cannot shift the answer', () => {
    // Due at 00:30 tomorrow, from 23:30 tonight, is still "tomorrow".
    const late = new Date('2026-09-10T23:30:00Z');
    expect(dueLabel(task({ due_at: new Date('2026-09-11T00:30:00Z') }), late)!.text)
      .toBe('Due tomorrow');
  });

  it('reads relatively within a week', () => {
    expect(dueLabel(task({ due_at: new Date('2026-09-15T00:00:00Z') }), NOW))
      .toEqual({ text: 'Due in 5 days', tone: 'soon' });
    expect(dueLabel(task({ due_at: new Date('2026-09-17T00:00:00Z') }), NOW)!.text)
      .toBe('Due in 7 days');
  });

  it('switches to an absolute date beyond a week', () => {
    const label = dueLabel(task({ due_at: new Date('2026-10-23T00:00:00Z') }), NOW)!;
    expect(label.text).toBe('Due Oct 23');
    expect(label.tone).toBe('normal');
  });

  it('marks an overdue task, singular and plural', () => {
    expect(dueLabel(task({ due_at: new Date('2026-09-09T00:00:00Z') }), NOW))
      .toEqual({ text: 'Overdue by 1 day', tone: 'overdue' });
    expect(dueLabel(task({ due_at: new Date('2026-09-01T00:00:00Z') }), NOW))
      .toEqual({ text: 'Overdue by 9 days', tone: 'overdue' });
  });

  it('handles a month boundary', () => {
    expect(dueLabel(task({ due_at: new Date('2026-08-31T00:00:00Z') }), NOW)!.text)
      .toBe('Overdue by 10 days');
  });
});

describe('age', () => {
  it('is zero on the day of creation', () => {
    expect(ageInDays(task(), NOW)).toBe(0);
    expect(ageLabel(task(), NOW)).toBe('today');
  });

  it('counts days and reads singular at one', () => {
    expect(ageLabel(task({ created_at: new Date('2026-09-09T23:00:00Z') }), NOW))
      .toBe('1 day');
    expect(ageLabel(task({ created_at: new Date('2026-09-01T00:00:00Z') }), NOW))
      .toBe('9 days');
  });

  it('crosses a month boundary correctly', () => {
    expect(ageInDays(task({ created_at: new Date('2026-08-11T00:00:00Z') }), NOW))
      .toBe(30);
  });

  it('switches to months past thirty days', () => {
    expect(ageLabel(task({ created_at: new Date('2026-08-11T00:00:00Z') }), NOW))
      .toBe('1 month');
    expect(ageLabel(task({ created_at: new Date('2026-03-10T00:00:00Z') }), NOW))
      .toBe('6 months');
  });

  it('never reports a negative age for a clock skew', () => {
    expect(ageInDays(task({ created_at: new Date('2026-09-12T00:00:00Z') }), NOW))
      .toBe(0);
  });
});

describe('links', () => {
  it('builds task and space hrefs', () => {
    // Editing is a query parameter on the current list, not a route, so the
    // list stays rendered behind the pane instead of being swapped out.
    expect(taskEditHref(task())).toBe('/?edit=T1');
    expect(spaceHref(space)).toBe('/spaces/nazareth-law');
  });

  it('opens the edit pane over the view it was opened from', () => {
    expect(taskEditHref(task(), '/spaces/marketing', { due: 'today' }))
      .toBe('/spaces/marketing?due=today&edit=T1');
  });

  it('carries filters through but never an existing edit param', () => {
    // Otherwise opening a second task would append to the first.
    expect(taskEditHref(task(), '/', { q: 'neil', edit: 'OLD' }))
      .toBe('/?q=neil&edit=T1');
  });

  it('closes the pane back to the same filtered view', () => {
    expect(closeEditHref('/spaces/marketing', { due: 'today', edit: 'T1' }))
      .toBe('/spaces/marketing?due=today');
    expect(closeEditHref('/', { edit: 'T1' })).toBe('/');
  });

  it('knows a client Space from its prefix', () => {
    expect(isClientSpace(space)).toBe(true);
    expect(isClientSpace({ ...space, name: 'Marketing' })).toBe(false);
  });

  it('builds a filter href, and omits the question mark when empty', () => {
    expect(filterHref('/', { space: 'marketing', q: 'neil' }))
      .toBe('/?space=marketing&q=neil');
    expect(filterHref('/waiting', {})).toBe('/waiting');
  });

  it('url-encodes a search term', () => {
    expect(filterHref('/', { q: 'neil & rachael' })).toContain('q=neil+%26+rachael');
  });
});

describe('shortSpaceName', () => {
  it('drops the client prefix and leaves other names alone', () => {
    expect(shortSpaceName(space)).toBe('Nazareth Law');
    expect(shortSpaceName({ ...space, name: 'Agency / Internal' }))
      .toBe('Agency / Internal');
  });
});
