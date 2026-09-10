import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask, getTask, completeTask } from '@tr/task-core';
import { saveCard } from '../cards.js';
import { handleCheckboxToggle, readSelectedValues } from './checkbox.js';

let db: Db;
let spaceId: string;
let space: any;
const config = {
  teamId: 'T_RILEY', authorizedUserIds: [], defaultAssigneeId: 'U_JOSH',
  assigneeLabels: { U_JOSH: 'Joshua' }, timeZone: 'America/Chicago', mode: 'socket' as const,
};

const client = { chat: { update: vi.fn() } };

beforeEach(async () => {
  db = await createTestDb();
  client.chat.update = vi.fn().mockResolvedValue({ ok: true });
  const { rows } = await db.query<any>(
    `SELECT id, name, slug, is_inbox FROM spaces WHERE name = 'Client - Nazareth Law'`
  );
  space = rows[0]; spaceId = rows[0].id;
});
afterEach(async () => { await db.close(); });

const seed = async (title = 'Offer Neil Instagram and Facebook package for $100') => {
  const task = await createTask(db, { title, spaceId, assigneeId: 'U_JOSH' });
  await saveCard(db, {
    channelId: 'C_NL', messageTs: '1700000000.000100', entries: [{ task, space }],
  });
  return task;
};

const payload = (selectedIds: string[], over: Record<string, unknown> = {}) => ({
  type: 'block_actions',
  team: { id: 'T_RILEY' },
  user: { id: 'U_JOSH' },
  channel: { id: 'C_NL' },
  container: { type: 'message', channel_id: 'C_NL', message_ts: '1700000000.000100' },
  actions: [{
    type: 'checkboxes', action_id: 'task_checkbox', block_id: 'task_toggle:0',
    action_ts: '1700000001.000001',
    selected_options: selectedIds.map((id) => ({ value: id })),
  }],
  state: {
    values: {
      'task_toggle:0': {
        task_checkbox: {
          type: 'checkboxes',
          selected_options: selectedIds.map((id) => ({ value: id })),
        },
      },
    },
  },
  ...over,
});

const deps = () => ({ db, client: client as never, config });

describe('readSelectedValues', () => {
  it('reads from state.values, the documented location', () => {
    expect(readSelectedValues(payload(['a']) as never, 'task_toggle:0', 'task_checkbox'))
      .toEqual(['a']);
  });

  it('falls back to action.selected_options when state is absent', () => {
    const p: any = payload(['b']); delete p.state;
    expect(readSelectedValues(p, 'task_toggle:0', 'task_checkbox')).toEqual(['b']);
  });

  it('falls back to action.options, which the docs example shows', () => {
    const p: any = payload([]);
    delete p.state;
    p.actions[0].selected_options = undefined;
    p.actions[0].options = [{ value: 'c' }];
    expect(readSelectedValues(p, 'task_toggle:0', 'task_checkbox')).toEqual(['c']);
  });

  it('treats an empty array as a genuine deselect-all, not missing data', () => {
    expect(readSelectedValues(payload([]) as never, 'task_toggle:0', 'task_checkbox')).toEqual([]);
  });
});

describe('completion via checkbox', () => {
  // Required test 5
  it('completes the exact task identified by the option value', async () => {
    const task = await seed();
    const other = await createTask(db, { title: 'Untouched', spaceId });
    const r = await handleCheckboxToggle(deps(), payload([task.id]) as never);
    expect(r.outcome).toBe('applied');
    expect((await getTask(db, task.id))!.status).toBe('completed');
    expect((await getTask(db, other.id))!.status).toBe('open');
  });

  // Required test 7
  it('updates the same Slack message in place', async () => {
    const task = await seed();
    await handleCheckboxToggle(deps(), payload([task.id]) as never);
    expect(client.chat.update).toHaveBeenCalledTimes(1);
    const arg = client.chat.update.mock.calls[0][0];
    expect(arg.channel).toBe('C_NL');
    expect(arg.ts).toBe('1700000000.000100');
  });

  // Required test 8
  it('renders the completed title with strikethrough and a checked box', async () => {
    const task = await seed();
    await handleCheckboxToggle(deps(), payload([task.id]) as never);
    const el = client.chat.update.mock.calls[0][0].blocks
      .find((b: any) => b.type === 'actions').elements[0];
    expect(el.options[0].text.text)
      .toBe('~Offer Neil Instagram and Facebook package for $100~');
    expect(el.initial_options).toHaveLength(1);
    expect(el.initial_options[0]).toBe(el.options[0]);
  });

  it('posts no additional message', async () => {
    const task = await seed();
    const spy = vi.fn();
    await handleCheckboxToggle(
      { db, client: { chat: { update: client.chat.update, postMessage: spy } } as never, config },
      payload([task.id]) as never
    );
    expect(spy).not.toHaveBeenCalled();
  });

  // Required test 6
  it('is idempotent across a duplicate Slack retry', async () => {
    const task = await seed();
    const p = payload([task.id]);
    await handleCheckboxToggle(deps(), p as never);
    const first = (await getTask(db, task.id))!.completed_at!.getTime();
    const second = await handleCheckboxToggle(deps(), p as never);
    expect(second.outcome).toBe('duplicate');
    expect((await getTask(db, task.id))!.completed_at!.getTime()).toBe(first);
    const { rows } = await db.query(
      `SELECT 1 FROM task_events WHERE task_id = $1 AND event = 'completed'`, [task.id]
    );
    expect(rows).toHaveLength(1);
  });

  it('redraws the completed state on a duplicate rather than silently dropping it', async () => {
    const task = await seed();
    const p = payload([task.id]);
    await handleCheckboxToggle(deps(), p as never);
    await handleCheckboxToggle(deps(), p as never);
    expect(client.chat.update).toHaveBeenCalledTimes(2);
  });
});

describe('reopen via uncheck', () => {
  const reseedCompleted = async (taskId: string) => {
    await saveCard(db, {
      channelId: 'C_NL', messageTs: '1700000000.000100',
      entries: [{ task: (await getTask(db, taskId))!, space }],
    });
  };

  it('reopens the task and clears completed_at', async () => {
    const task = await seed();
    await completeTask(db, task.id, { id: 'U_JOSH', source: 'test' });
    await reseedCompleted(task.id);
    const r = await handleCheckboxToggle(deps(), payload([]) as never);
    expect(r.outcome).toBe('applied');
    const back = (await getTask(db, task.id))!;
    expect(back.status).toBe('open');
    expect(back.completed_at).toBeNull();
    expect(back.title).toBe(task.title);
  });

  it('renders the reopened title without strikethrough and unchecked', async () => {
    const task = await seed();
    await completeTask(db, task.id, { id: 'U_JOSH', source: 'test' });
    await reseedCompleted(task.id);
    await handleCheckboxToggle(deps(), payload([]) as never);
    const el = client.chat.update.mock.calls[0][0].blocks
      .find((b: any) => b.type === 'actions').elements[0];
    expect(el.options[0].text.text).toBe(task.title);
    expect(el.options[0].text.type).toBe('plain_text');
    expect(el.initial_options).toBeUndefined();
  });

  it('is a no-op when unchecking an already-open task', async () => {
    const task = await seed();
    const r = await handleCheckboxToggle(deps(), payload([]) as never);
    expect(r.outcome).toBe('noop');
    expect((await getTask(db, task.id))!.status).toBe('open');
    const { rows } = await db.query(
      `SELECT 1 FROM task_events WHERE task_id = $1 AND event = 'reopened'`, [task.id]
    );
    expect(rows).toHaveLength(0);
  });
});

describe('grouped cards', () => {
  it('applies only the toggled task, leaving stale siblings alone', async () => {
    const a = await createTask(db, { title: 'Meditate', spaceId });
    const b = await createTask(db, { title: 'Exercise', spaceId });
    await completeTask(db, b.id, { id: 'U_JOSH', source: 'test' });
    const bDone = (await getTask(db, b.id))!;
    await saveCard(db, {
      channelId: 'C_NL', messageTs: '1700000000.000100',
      entries: [{ task: a, space }, { task: bDone, space }],
    });
    const r = await handleCheckboxToggle(deps(), payload([a.id, b.id]) as never);
    expect(r.outcome).toBe('applied');
    expect((await getTask(db, a.id))!.status).toBe('completed');
    expect((await getTask(db, b.id))!.completed_at!.getTime())
      .toBe(bDone.completed_at!.getTime());
  });

  it('reopens only the task the user actually unchecked', async () => {
    const a = await createTask(db, { title: 'Meditate', spaceId });
    const b = await createTask(db, { title: 'Exercise', spaceId });
    await completeTask(db, a.id, { id: 'U_JOSH', source: 'test' });
    await completeTask(db, b.id, { id: 'U_JOSH', source: 'test' });
    await saveCard(db, {
      channelId: 'C_NL', messageTs: '1700000000.000100',
      entries: [
        { task: (await getTask(db, a.id))!, space },
        { task: (await getTask(db, b.id))!, space },
      ],
    });
    await handleCheckboxToggle(deps(), payload([b.id]) as never);
    expect((await getTask(db, a.id))!.status).toBe('open');
    expect((await getTask(db, b.id))!.status).toBe('completed');
  });
});

describe('rejections', () => {
  // Required test 16
  it('rejects an unauthorized user with zero mutation', async () => {
    const task = await seed();
    const r = await handleCheckboxToggle(
      deps(), payload([task.id], { team: { id: 'T_INTRUDER' } }) as never
    );
    expect(r.outcome).toBe('unauthorized');
    expect((await getTask(db, task.id))!.status).toBe('open');
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  // Required tests 17, 18
  it('rejects a malformed task id without mutating anything', async () => {
    await seed();
    const r = await handleCheckboxToggle(deps(), payload(["'; DROP TABLE tasks; --"]) as never);
    expect(r.outcome).toBe('noop');
    const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks`);
    expect(rows[0]!.n).toBe(1);
  });

  it('ignores an option value that is not part of the recorded card', async () => {
    const task = await seed();
    const foreign = await createTask(db, { title: 'Not on this card', spaceId });
    await handleCheckboxToggle(deps(), payload([task.id, foreign.id]) as never);
    expect((await getTask(db, foreign.id))!.status).toBe('open');
  });

  it('returns unknown_card for a message it has no record of', async () => {
    const r = await handleCheckboxToggle(
      deps(),
      payload([], { container: { type: 'message', channel_id: 'C_NL', message_ts: '9.9' } }) as never
    );
    expect(r.outcome).toBe('unknown_card');
  });
});
