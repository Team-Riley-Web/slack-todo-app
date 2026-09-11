import { describe, it, expect } from 'vitest';
import { parseAssigneeLabels, assigneeChoices } from './assignees.js';

describe('parseAssigneeLabels', () => {
  it('reads the pairs', () => {
    expect(parseAssigneeLabels('U0BU0V0850Q=Joshua,U0BT6HDBYBC=Rachael'))
      .toEqual({ U0BU0V0850Q: 'Joshua', U0BT6HDBYBC: 'Rachael' });
  });

  it('tolerates spacing and a trailing comma', () => {
    expect(parseAssigneeLabels(' U1 = Joshua , U2 = Rachael , '))
      .toEqual({ U1: 'Joshua', U2: 'Rachael' });
  });

  it('is empty for nothing at all', () => {
    for (const raw of [undefined, null, '', '   ', ',,,']) {
      expect(parseAssigneeLabels(raw)).toEqual({});
    }
  });

  it('skips a malformed entry rather than throwing', () => {
    // A stray comma should cost one name, not stop the app from booting.
    expect(parseAssigneeLabels('U1=Joshua,garbage,U2=Rachael'))
      .toEqual({ U1: 'Joshua', U2: 'Rachael' });
    expect(parseAssigneeLabels('U1=,=Joshua,U2=Rachael'))
      .toEqual({ U2: 'Rachael' });
  });

  it('rejects anything that is not shaped like a Slack id', () => {
    // Otherwise a typo becomes a phantom assignee nobody can be.
    expect(parseAssigneeLabels('joshua=Joshua')).toEqual({});
    expect(parseAssigneeLabels('U 1=Joshua')).toEqual({});
  });

  it('keeps an = inside a label', () => {
    expect(parseAssigneeLabels('U1=A=B')).toEqual({ U1: 'A=B' });
  });

  it('lets a later entry win, so a duplicate id is not ambiguous', () => {
    expect(parseAssigneeLabels('U1=Old,U1=New')).toEqual({ U1: 'New' });
  });
});

describe('assigneeChoices', () => {
  const labels = { U_J: 'Joshua', U_R: 'Rachael' };

  it('sorts by the name shown, not the id', () => {
    expect(assigneeChoices({ U_Z: 'Aaron', U_A: 'Zoe' }))
      .toEqual([['U_Z', 'Aaron'], ['U_A', 'Zoe']]);
  });

  it('offers a configured person before they have any task', () => {
    // The reason this matters: Rachael has to be selectable to receive her
    // first task, so the list cannot come only from tasks that exist.
    expect(assigneeChoices(labels, []).map(([, l]) => l))
      .toEqual(['Joshua', 'Rachael']);
  });

  it('includes an id in use that nobody configured, labelled as itself', () => {
    const out = assigneeChoices(labels, ['U_GHOST']);
    expect(out).toContainEqual(['U_GHOST', 'U_GHOST']);
  });

  it('does not list someone twice when configured and in use', () => {
    expect(assigneeChoices(labels, ['U_J', 'U_R'])).toHaveLength(2);
  });

  it('is empty when there is nothing to offer', () => {
    expect(assigneeChoices({}, [])).toEqual([]);
  });
});
