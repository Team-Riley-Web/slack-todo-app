import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask, completeTask, moveTask } from '@tr/task-core';
import { handleTasksCommand } from './tasks-command.js';

let db: Db;
const spaceIds: Record<string, string> = {};
const client = { chat: { postEphemeral: vi.fn(), postMessage: vi.fn() } };
const config = {
  teamId: 'T_RILEY', authorizedUserIds: [], defaultAssigneeId: 'U_JOSH',
  assigneeLabels: { U_JOSH: 'Joshua' }, timeZone: 'America/Chicago', mode: 'socket' as const,
};
const actor = { id: 'U_JOSH', source: 'test' };

beforeEach(async () => {
  db = await createTestDb();
  client.chat.postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  client.chat.postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1700000000.000400' });
  const { rows } = await db.query<{ id: string; name: string }>(`SELECT id, name FROM spaces`);
  for (const r of rows) spaceIds[r.name] = r.id;
});
afterEach(async () => { await db.close(); });

const cmd = (text: string, over: Record<string, unknown> = {}) => ({
  text, channel_id: 'C_AGENCY', user_id: 'U_JOSH', team_id: 'T_RILEY', ...over,
});
const deps = () => ({ db, client: client as never, config });
const add = (space: string, title: string) =>
  createTask(db, { title, spaceId: spaceIds[space]!, assigneeId: 'U_JOSH' });
const posted = () =>
  JSON.stringify(
    client.chat.postEphemeral.mock.calls[0]?.[0] ?? client.chat.postMessage.mock.calls[0]![0]!
  );

// Required tests 9, 12
it('summarizes counts per space, excluding completed tasks', async () => {
  const done = await add('Agency / Internal', 'Done');
  await add('Agency / Internal', 'A');
  await add('Marketing', 'B');
  await completeTask(db, done.id, actor);

  await handleTasksCommand(deps(), cmd('') as never);
  const out = posted();
  expect(out).toContain('Agency / Internal');
  expect(out).toContain('Marketing');
  expect(out).not.toContain('Done');
  expect(out).toMatch(/Agency \/ Internal[^0-9]*1/);
});

it('reports waiting counts alongside open counts', async () => {
  const w = await add('Sales', 'Waiting one');
  await add('Sales', 'Open one');
  await moveTask(db, w.id, { status: 'waiting' }, actor);
  await handleTasksCommand(deps(), cmd('') as never);
  expect(posted()).toContain('1 waiting');
});

// Required test 13
it('scopes to a space by partial name with interactive controls', async () => {
  await add('Agency / Internal', 'Agency one');
  await add('Personal', 'Personal one');
  const r = await handleTasksCommand(deps(), cmd('agency') as never);
  expect(r.count).toBe(1);
  const out = posted();
  expect(out).toContain('Agency one');
  expect(out).not.toContain('Personal one');
  expect(out).toContain('checkboxes');
});

it('resolves a multi-word client scope', async () => {
  await add('Client - Joy Within Birth', 'JWB task');
  const r = await handleTasksCommand(deps(), cmd('joy within') as never);
  expect(r.count).toBe(1);
  expect(posted()).toContain('JWB task');
});

it('shows the waiting view and excludes open tasks', async () => {
  const w = await add('Client - Milltown Cabinets', 'Waiting one');
  await add('Marketing', 'Open one');
  await moveTask(db, w.id, { status: 'waiting', waitingOn: 'Milltown' }, actor);

  const r = await handleTasksCommand(deps(), cmd('waiting') as never);
  expect(r.scope).toBe('waiting');
  expect(r.count).toBe(1);
  const out = posted();
  expect(out).toContain('Waiting one');
  expect(out).not.toContain('Open one');
});

// Required test 10
it('excludes waiting tasks from a normal space view', async () => {
  const w = await add('Marketing', 'Waiting one');
  await add('Marketing', 'Open one');
  await moveTask(db, w.id, { status: 'waiting' }, actor);
  const r = await handleTasksCommand(deps(), cmd('marketing') as never);
  expect(r.count).toBe(1);
  expect(posted()).toContain('Open one');
});

it('reports an unknown scope without throwing', async () => {
  const r = await handleTasksCommand(deps(), cmd('nonsense-scope') as never);
  expect(r.count).toBe(0);
  expect(posted().toLowerCase()).toContain('no space');
});

it('records posted list cards so their checkboxes work', async () => {
  await add('Marketing', 'B');
  await handleTasksCommand(deps(), cmd('marketing') as never);
  const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM slack_cards`);
  expect(rows[0]!.n).toBe(1);
});

it('paginates a scope with more than ten tasks into multiple checkbox elements', async () => {
  for (let i = 0; i < 12; i += 1) await add('Sales', `Task ${i}`);
  await handleTasksCommand(deps(), cmd('sales') as never);
  const blocks = client.chat.postMessage.mock.calls[0]![0]!.blocks as any[];
  const groups = blocks.filter((b) => b.type === 'actions');
  expect(groups.map((g: any) => g.elements[0].options.length)).toEqual([10, 2]);
});

it('rejects an unauthorized workspace', async () => {
  const r = await handleTasksCommand(deps(), cmd('', { team_id: 'T_OTHER' }) as never);
  expect(r.scope).toBe('unauthorized');
});
