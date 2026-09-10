import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask, completeTask, getTask, listSpaces, type Space } from '@tr/task-core';
import { saveCard } from './cards.js';
import { syncCardsForTask } from './sync.js';

let db: Db;
let space: Space;
const config = { timeZone: 'America/Chicago', assigneeLabels: { U_JOSH: 'Joshua' } };
const client = { chat: { update: vi.fn() } };
const deps = () => ({ db, client: client as never, config });

beforeEach(async () => {
  db = await createTestDb();
  client.chat.update = vi.fn().mockResolvedValue({ ok: true });
  space = (await listSpaces(db)).find((s) => s.name === 'Marketing')!;
});
afterEach(async () => { await db.close(); });

const card = (channelId: string, messageTs: string, tasks: Awaited<ReturnType<typeof createTask>>[]) =>
  saveCard(db, {
    channelId, messageTs,
    entries: tasks.map((task) => ({ task, space })),
    version: 1,
  });

describe('syncCardsForTask', () => {
  it('redraws the one card a task appears on', async () => {
    const task = await createTask(db, { title: 'Call Neil', spaceId: space.id });
    await card('C_MKT', '1700000000.000100', [task]);

    const result = await syncCardsForTask(deps(), task.id);
    expect(result).toEqual({ cards: 1, failed: 0 });
    expect(client.chat.update).toHaveBeenCalledTimes(1);
    const arg = client.chat.update.mock.calls[0]![0] as any;
    expect(arg.channel).toBe('C_MKT');
    expect(arg.ts).toBe('1700000000.000100');
  });

  it('redraws every card the task appears on', async () => {
    // Its own capture card plus two /tasks list cards.
    const task = await createTask(db, { title: 'On three cards', spaceId: space.id });
    const other = await createTask(db, { title: 'Sibling', spaceId: space.id });
    await card('C_MKT', '1.1', [task]);
    await card('C_MKT', '2.2', [task, other]);
    await card('C_OPS', '3.3', [other, task]);

    const result = await syncCardsForTask(deps(), task.id);
    expect(result).toEqual({ cards: 3, failed: 0 });
    const targets = client.chat.update.mock.calls.map((c: any) => `${c[0].channel}/${c[0].ts}`);
    expect(targets.sort()).toEqual(['C_MKT/1.1', 'C_MKT/2.2', 'C_OPS/3.3']);
  });

  it('does nothing when the task is on no card', async () => {
    const task = await createTask(db, { title: 'Never posted', spaceId: space.id });
    expect(await syncCardsForTask(deps(), task.id)).toEqual({ cards: 0, failed: 0 });
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it('ignores cards that do not contain the task', async () => {
    const task = await createTask(db, { title: 'Mine', spaceId: space.id });
    const other = await createTask(db, { title: 'Not mine', spaceId: space.id });
    await card('C_MKT', '1.1', [task]);
    await card('C_MKT', '2.2', [other]);

    expect((await syncCardsForTask(deps(), task.id)).cards).toBe(1);
    expect((client.chat.update.mock.calls[0]![0] as any).ts).toBe('1.1');
  });

  it('renders current database state, not what the card last showed', async () => {
    const task = await createTask(db, { title: 'Finish me', spaceId: space.id });
    await card('C_MKT', '1.1', [task]); // rendered while open

    await completeTask(db, task.id, { id: 'U_JOSH', source: 'web' });
    await syncCardsForTask(deps(), task.id);

    const el = (client.chat.update.mock.calls[0]![0] as any).blocks
      .find((b: any) => b.type === 'actions').elements[0];
    expect(el.options[0].text.text).toBe('~Finish me~');
    expect(el.options[0].text.type).toBe('mrkdwn');
    expect(el.initial_options).toHaveLength(1);
  });

  it('refreshes the siblings on a shared card from the database too', async () => {
    const a = await createTask(db, { title: 'Alpha', spaceId: space.id });
    const b = await createTask(db, { title: 'Beta', spaceId: space.id });
    await card('C_MKT', '1.1', [a, b]); // both rendered open

    // Complete BOTH, then sync for only one of them.
    await completeTask(db, a.id, { id: 'U_JOSH', source: 'web' });
    await completeTask(db, b.id, { id: 'U_JOSH', source: 'web' });
    await syncCardsForTask(deps(), a.id);

    const el = (client.chat.update.mock.calls[0]![0] as any).blocks
      .find((b2: any) => b2.type === 'actions').elements[0];
    expect(el.initial_options).toHaveLength(2); // both shown done, not just alpha
  });

  it('advances the render version so a stale click cannot revert it', async () => {
    const task = await createTask(db, { title: 'Versioned', spaceId: space.id });
    await card('C_MKT', '1.1', [task]);
    await syncCardsForTask(deps(), task.id);

    const { rows } = await db.query<{ version: number }>(
      `SELECT version FROM slack_cards WHERE message_ts = '1.1'`
    );
    expect(Number(rows[0]!.version)).toBe(2);

    const blockId = (client.chat.update.mock.calls[0]![0] as any).blocks
      .find((b: any) => b.type === 'actions').block_id;
    expect(blockId).toMatch(/:v2$/);
  });
});

describe('a Slack failure must not lose the task change', () => {
  it('counts the failure and does not throw', async () => {
    const task = await createTask(db, { title: 'Already saved', spaceId: space.id });
    await card('C_MKT', '1.1', [task]);
    await completeTask(db, task.id, { id: 'U_JOSH', source: 'web' });

    client.chat.update = vi.fn().mockRejectedValue(new Error('slack is down'));

    const result = await syncCardsForTask(deps(), task.id);
    expect(result).toEqual({ cards: 0, failed: 1 });

    // The task change stands regardless.
    expect((await getTask(db, task.id))!.status).toBe('completed');
  });

  it('keeps going after one card fails', async () => {
    const task = await createTask(db, { title: 'On two cards', spaceId: space.id });
    await card('C_MKT', '1.1', [task]);
    await card('C_OPS', '2.2', [task]);

    let call = 0;
    client.chat.update = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('first one fails');
      return { ok: true };
    });

    expect(await syncCardsForTask(deps(), task.id)).toEqual({ cards: 1, failed: 1 });
    expect(client.chat.update).toHaveBeenCalledTimes(2);
  });
});

describe('locking', () => {
  it('does not overlap redraws of the same card', async () => {
    const task = await createTask(db, { title: 'Locked', spaceId: space.id });
    await card('C_MKT', '1.1', [task]);

    const events: string[] = [];
    client.chat.update = vi.fn(async () => {
      events.push('start');
      await new Promise((r) => setTimeout(r, 20));
      events.push('end');
      return { ok: true };
    });

    await Promise.all([
      syncCardsForTask(deps(), task.id),
      syncCardsForTask(deps(), task.id),
    ]);

    // Each start is immediately followed by its own end: no interleaving.
    expect(events).toEqual(['start', 'end', 'start', 'end']);
  });
});
