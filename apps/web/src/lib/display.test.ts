import { describe, it, expect } from 'vitest';
import {
  dueLabel, ageInDays, ageLabel, taskEditHref, closeEditHref, isClientSpace,
  spaceHref, filterHref, shortSpaceName, spaceBySlug, newTaskHref,
  closeNewTaskHref, newTaskSpace,
} from './display.js';
import { parseDueInput, type Task, type Space } from '@tr/task-core';

const NOW = new Date('2026-09-10T12:00:00Z');

const task = (over: Partial<Task> = {}): Task => ({
  id: 'T1', title: 'Call Neil', space_id: 'S1', list_id: null, assignee_id: null,
  status: 'open', priority: null, due_at: null, waiting_on: null, details: null,
  created_at: new Date('2026-09-10T09:00:00Z'), completed_at: null,
  source_platform: 'web', source_channel_id: null, source_message_ts: null,
  created_by: null, source_external_id: null, import_batch_id: null, ...over,
});

const space: Space = {
  id: 'S1', name: 'Client - Nazareth Law', slug: 'nazareth-law', is_inbox: false,
};

/** A Chicago wall-clock time as an instant, the way the app now reads one. */
const chi = (local: string) => parseDueInput(local, 'America/Chicago');

describe('dueLabel', () => {
  // NOW is 7am CDT, Sep 10.
  it('returns null with no due date', () => {
    expect(dueLabel(task(), NOW)).toBeNull();
  });

  it('reads relatively for today and tomorrow', () => {
    expect(dueLabel(task({ due_at: chi('2026-09-10T18:00') }), NOW))
      .toEqual({ text: 'Due today', tone: 'soon' });
    expect(dueLabel(task({ due_at: chi('2026-09-11T08:00') }), NOW))
      .toEqual({ text: 'Due tomorrow', tone: 'soon' });
  });

  it('calls 8pm tonight in Chicago "today" -- UTC had already moved on to tomorrow', () => {
    const afternoon = chi('2026-09-10T15:30');
    const tonight = new Date('2026-09-11T01:00:00Z'); // 8pm CDT, Sep 10
    expect(dueLabel(task({ due_at: tonight }), afternoon)!.text).toBe('Due today');
  });

  it('counts calendar days, so a time of day cannot shift the answer', () => {
    // Due at 00:30 tomorrow, from 23:30 tonight, is still "tomorrow".
    const late = chi('2026-09-10T23:30');
    expect(dueLabel(task({ due_at: chi('2026-09-11T00:30') }), late)!.text)
      .toBe('Due tomorrow');
  });

  it('reads relatively within a week', () => {
    expect(dueLabel(task({ due_at: chi('2026-09-15') }), NOW))
      .toEqual({ text: 'Due in 5 days', tone: 'soon' });
    expect(dueLabel(task({ due_at: chi('2026-09-17T09:00') }), NOW)!.text)
      .toBe('Due in 7 days');
  });

  it('switches to an absolute date beyond a week, dated in Chicago', () => {
    const label = dueLabel(task({ due_at: chi('2026-10-23') }), NOW)!;
    expect(label.text).toBe('Due Oct 23');
    expect(label.tone).toBe('normal');
  });

  it('marks an overdue task, singular and plural', () => {
    expect(dueLabel(task({ due_at: chi('2026-09-09') }), NOW))
      .toEqual({ text: 'Overdue by 1 day', tone: 'overdue' });
    expect(dueLabel(task({ due_at: chi('2026-09-01') }), NOW))
      .toEqual({ text: 'Overdue by 9 days', tone: 'overdue' });
  });

  it('handles a month boundary', () => {
    expect(dueLabel(task({ due_at: chi('2026-08-31') }), NOW)!.text)
      .toBe('Overdue by 10 days');
  });

  it('counts in the zone it is given', () => {
    // 11:30pm CDT is already 12:30am in New York.
    const at = new Date('2026-09-11T04:30:00Z');
    const evening = new Date('2026-09-11T02:00:00Z');
    expect(dueLabel(task({ due_at: at }), evening, 'America/Chicago')!.text).toBe('Due today');
    expect(dueLabel(task({ due_at: at }), evening, 'America/New_York')!.text).toBe('Due tomorrow');
  });
});

describe('age', () => {
  it('is zero on the day of creation', () => {
    expect(ageInDays(task(), NOW)).toBe(0);
    expect(ageLabel(task(), NOW)).toBe('today');
  });

  it('counts days and reads singular at one', () => {
    expect(ageLabel(task({ created_at: chi('2026-09-09T18:00') }), NOW)).toBe('1 day');
    expect(ageLabel(task({ created_at: chi('2026-09-01') }), NOW)).toBe('9 days');
  });

  it('crosses a month boundary correctly', () => {
    expect(ageInDays(task({ created_at: chi('2026-08-11') }), NOW)).toBe(30);
  });

  it('switches to months past thirty days', () => {
    expect(ageLabel(task({ created_at: chi('2026-08-11') }), NOW)).toBe('1 month');
    expect(ageLabel(task({ created_at: chi('2026-03-10') }), NOW)).toBe('6 months');
  });

  it('never reports a negative age for a clock skew', () => {
    expect(ageInDays(task({ created_at: chi('2026-09-12') }), NOW)).toBe(0);
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

  it('opens new-task capture over the current filtered view', () => {
    expect(newTaskHref('/waiting', { space: 'marketing', q: 'neil' }))
      .toBe('/waiting?space=marketing&q=neil&newTask=1');
  });

  it('does not carry an edit pane or stale error into new-task capture', () => {
    expect(newTaskHref('/', { edit: 'T1', error: 'old', newTask: '1' }))
      .toBe('/?newTask=1');
  });

  it('closes new-task capture back to the same filtered view', () => {
    expect(closeNewTaskHref('/today', {
      space: 'marketing', newTask: '1', error: 'A task needs a title.',
    })).toBe('/today?space=marketing');
    expect(closeNewTaskHref('/', { newTask: '1' })).toBe('/');
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

describe('spaceBySlug', () => {
  const spaces: Space[] = [
    { id: 'S1', name: 'Marketing', slug: 'marketing', is_inbox: false },
    { id: 'S2', name: 'Client - CFC Skincare', slug: 'cfc-skincare', is_inbox: false },
  ];

  it('finds the Space a ?space= filter names', () => {
    expect(spaceBySlug(spaces, 'cfc-skincare')?.name).toBe('Client - CFC Skincare');
  });

  it('returns null for no filter, so the view keeps its own title', () => {
    expect(spaceBySlug(spaces, undefined)).toBeNull();
    expect(spaceBySlug(spaces, null)).toBeNull();
    expect(spaceBySlug(spaces, '')).toBeNull();
  });

  it('returns null for a slug that no longer exists', () => {
    // A stale bookmark, or a link kept after a rename regenerated the slug.
    // Falling back to the unfiltered heading beats titling the page after a
    // Space that is not there.
    expect(spaceBySlug(spaces, 'yoga-farm')).toBeNull();
  });

  it('matches the slug exactly, not by prefix or case', () => {
    expect(spaceBySlug(spaces, 'cfc')).toBeNull();
    expect(spaceBySlug(spaces, 'CFC-Skincare')).toBeNull();
  });
});

describe('newTaskSpace', () => {
  const spaces: Space[] = [
    { id: 'INBOX', name: 'Inbox', slug: 'inbox', is_inbox: true },
    { id: 'S1', name: 'Marketing', slug: 'marketing', is_inbox: false },
  ];

  it('preselects the Space currently in view', () => {
    expect(newTaskSpace(spaces, 'marketing')?.id).toBe('S1');
  });

  it('preselects Inbox on a cross-Space view', () => {
    expect(newTaskSpace(spaces, null)?.id).toBe('INBOX');
    expect(newTaskSpace(spaces, 'missing')?.id).toBe('INBOX');
  });

  it('still returns a usable choice if Inbox is missing', () => {
    expect(newTaskSpace(spaces.slice(1), null)?.id).toBe('S1');
    expect(newTaskSpace([], null)).toBeNull();
  });
});
