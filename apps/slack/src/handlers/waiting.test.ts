import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask, getTask, listTasks } from '@tr/task-core';
import { saveCard } from '@tr/slack-sync';
import { handleWaitingAction, WAITING_ACTION_ID } from './waiting.js';

let db: Db;
let space: any;
const client = { chat: { update: vi.fn() } };
const config = {
  teamId: 'T_RILEY', authorizedUserIds: [], defaultAssigneeId: 'U_JOSH',
  assigneeLabels: { U_JOSH: 'Joshua' }, timeZone: 'America/Chicago', mode: 'socket' as const,
};

beforeEach(async () => {
  db = await createTestDb();
  client.chat.update = vi.fn().mockResolvedValue({ ok: true });
  const { rows } = await db.query<any>(
    `SELECT id, name, slug, is_inbox FROM spaces WHERE name = 'Client - Milltown Cabinets'`
  );
  space = rows[0];
});
afterEach(async () => { await db.close(); });

const body = (value: string, over: Record<string, unknown> = {}) => ({
  type: 'block_actions',
  team: { id: 'T_RILEY' }, user: { id: 'U_JOSH' },
  container: { type: 'message', channel_id: 'C_MC', message_ts: '1700000000.000300' },
  actions: [{
    type: 'overflow', action_id: WAITING_ACTION_ID, block_id: 'task_controls:0',
    action_ts: '1700000002.000002', selected_option: { value },
  }],
  ...over,
});
const deps = () => ({ db, client: client as never, config });

const seed = async (title = 'Waiting on Milltown’s reply to the email proposal') => {
  const task = await createTask(db, { title, spaceId: space.id });
  await saveCard(db, {
    channelId: 'C_MC', messageTs: '1700000000.000300', entries: [{ task, space }],
  });
  return task;
};

// Required tests 10, 11
it('moves the task to waiting and keeps it out of the actionable list', async () => {
  const task = await seed();
  const r = await handleWaitingAction(deps(), body(`waiting:${task.id}`) as never);
  expect(r.outcome).toBe('applied');

  const moved = (await getTask(db, task.id))!;
  expect(moved.status).toBe('waiting');
  expect(moved.title).toBe('Waiting on Milltown’s reply to the email proposal');
  expect(await listTasks(db, { actionableOnly: true })).toHaveLength(0);
});

it('does not complete a waiting task', async () => {
  const task = await seed('X');
  await handleWaitingAction(deps(), body(`waiting:${task.id}`) as never);
  expect((await getTask(db, task.id))!.completed_at).toBeNull();
});

it('moves a waiting task back to open and clears waiting_on', async () => {
  const task = await seed('X');
  await handleWaitingAction(deps(), body(`waiting:${task.id}`) as never);
  const r = await handleWaitingAction(
    deps(),
    body(`open:${task.id}`, {
      actions: [{
        type: 'overflow', action_id: WAITING_ACTION_ID, block_id: 'task_controls:0',
        action_ts: '1700000003.000003', selected_option: { value: `open:${task.id}` },
      }],
    }) as never
  );
  expect(r.outcome).toBe('applied');
  const back = (await getTask(db, task.id))!;
  expect(back.status).toBe('open');
  expect(back.waiting_on).toBeNull();
});

it('redraws the same message in place', async () => {
  const task = await seed('X');
  await handleWaitingAction(deps(), body(`waiting:${task.id}`) as never);
  expect(client.chat.update.mock.calls[0]![0]!.ts).toBe('1700000000.000300');
});

it('rejects an unauthorized user with no mutation', async () => {
  const task = await seed('X');
  const r = await handleWaitingAction(
    deps(), body(`waiting:${task.id}`, { team: { id: 'T_OTHER' } }) as never
  );
  expect(r.outcome).toBe('unauthorized');
  expect((await getTask(db, task.id))!.status).toBe('open');
});

it('rejects a malformed id in the option value', async () => {
  const task = await seed('X');
  const r = await handleWaitingAction(deps(), body('waiting:not-a-uuid') as never);
  expect(r.outcome).toBe('noop');
  expect((await getTask(db, task.id))!.status).toBe('open');
});

it('rejects an unknown verb', async () => {
  const task = await seed('X');
  const r = await handleWaitingAction(deps(), body(`delete:${task.id}`) as never);
  expect(r.outcome).toBe('noop');
  expect((await getTask(db, task.id))!.status).toBe('open');
});
