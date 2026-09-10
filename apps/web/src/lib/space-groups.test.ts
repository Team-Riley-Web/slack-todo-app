import { describe, it, expect } from 'vitest';
import type { Space } from '@tr/task-core';
import { spaceGroups } from './space-groups.js';

const space = (name: string, over: Partial<Space> = {}): Space => ({
  id: `id-${name}`,
  name,
  slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  is_inbox: false,
  ...over,
});

// The order listSpaces returns: Inbox first, then by DISPLAYED name, which is
// why the clients look interleaved before grouping.
const all = [
  space('Inbox', { is_inbox: true }),
  space('Agency'),
  space('Client - CFC Skincare'),
  space('Finances'),
  space('Client - Joy Within Birth'),
  space('Marketing'),
  space('Client - Milltown Cabinets'),
  space('Music'),
];

describe('spaceGroups', () => {
  it('splits into Spaces then Clients', () => {
    expect(spaceGroups(all, (s) => s.id).map((g) => g.label))
      .toEqual(['Spaces', 'Clients']);
  });

  it('strips the prefix from client labels and keeps it out of Spaces', () => {
    const [internal, clients] = spaceGroups(all, (s) => s.id);
    expect(clients!.choices.map((c) => c.label))
      .toEqual(['CFC Skincare', 'Joy Within Birth', 'Milltown Cabinets']);
    expect(internal!.choices.map((c) => c.label))
      .toEqual(['Inbox', 'Agency', 'Finances', 'Marketing', 'Music']);
  });

  it('leaves the submitted value untouched by the label change', () => {
    // The reason this matters: the label a person reads and the value a form
    // posts are different strings for a client, and only the label is short.
    const [, clients] = spaceGroups(all, (s) => s.name);
    expect(clients!.choices.map((c) => c.value))
      .toEqual([
        'Client - CFC Skincare',
        'Client - Joy Within Birth',
        'Client - Milltown Cabinets',
      ]);
  });

  it('honours valueOf, so id and name callers both work', () => {
    expect(spaceGroups([space('Marketing')], (s) => s.id)[0]!.choices[0]!.value)
      .toBe('id-Marketing');
    expect(spaceGroups([space('Marketing')], (s) => s.name)[0]!.choices[0]!.value)
      .toBe('Marketing');
  });

  it('preserves the incoming order within each group', () => {
    // Sorting is listSpaces's job; re-sorting here could disagree with the
    // sidebar, which renders the same Spaces in the same order.
    const groups = spaceGroups(
      [space('Zebra'), space('Apple'), space('Client - Zulu'), space('Client - Alpha')],
      (s) => s.id
    );
    expect(groups[0]!.choices.map((c) => c.label)).toEqual(['Zebra', 'Apple']);
    expect(groups[1]!.choices.map((c) => c.label)).toEqual(['Zulu', 'Alpha']);
  });

  it('omits a group with nothing in it', () => {
    expect(spaceGroups([space('Marketing')], (s) => s.id).map((g) => g.label))
      .toEqual(['Spaces']);
    expect(spaceGroups([space('Client - CFC Skincare')], (s) => s.id).map((g) => g.label))
      .toEqual(['Clients']);
    expect(spaceGroups([], (s) => s.id)).toEqual([]);
  });

  it('does not treat a Space merely containing the word Client as one', () => {
    const groups = spaceGroups([space('Client onboarding')], (s) => s.id);
    expect(groups.map((g) => g.label)).toEqual(['Spaces']);
    expect(groups[0]!.choices[0]!.label).toBe('Client onboarding');
  });
});
