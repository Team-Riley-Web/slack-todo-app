import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { listSpaces } from '@tr/task-core';
import {
  handleNewSpaceCommand, parseNewSpaceCommand,
} from './space-command.js';
import { handleTasksCommand } from './tasks-command.js';

let db: Db;
const client = {
  chat: { postEphemeral: vi.fn(), postMessage: vi.fn() },
  views: { open: vi.fn() },
};
const config = {
  teamId: 'T_RILEY', authorizedUserIds: ['U_JOSH'], defaultAssigneeId: null,
  assigneeLabels: {}, timeZone: 'America/Chicago', mode: 'socket' as const,
};
const deps = () => ({ db, client: client as never, config });

beforeEach(async () => {
  db = await createTestDb();
  client.chat.postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  client.chat.postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1.1' });
  client.views.open = vi.fn().mockResolvedValue({ ok: true });
});
afterEach(async () => { await db.close(); });

const cmd = (text: string) => ({
  text, channel_id: 'C_AGENCY', user_id: 'U_JOSH', team_id: 'T_RILEY',
  trigger_id: 'TRIG',
});
const said = () => String(client.chat.postEphemeral.mock.calls[0]?.[0]?.text ?? '');
const named = async (name: string) =>
  (await listSpaces(db)).find((s) => s.name === name);

it('parses the name out of the subcommand', () => {
  expect(parseNewSpaceCommand('new Client - Rosario')).toBe('Client - Rosario');
  expect(parseNewSpaceCommand('  NEW   Rosario  ')).toBe('Rosario');
});

it('is not the subcommand without a name after it', () => {
  // So a bare `/tasks new` is not a creation with an empty name.
  expect(parseNewSpaceCommand('new')).toBeNull();
  expect(parseNewSpaceCommand('')).toBeNull();
  expect(parseNewSpaceCommand(undefined)).toBeNull();
  expect(parseNewSpaceCommand('newsletter')).toBeNull();
});

it('no seeded Space is named in a way the subcommand would swallow', async () => {
  const names = (await listSpaces(db)).map((s) => s.name.toLowerCase());
  expect(names).not.toContain('new');
});

it('creates the Space and says how to use it', async () => {
  const r = await handleNewSpaceCommand(deps(), cmd('new Client - Rosario') as never, 'Client - Rosario');
  expect(r.outcome).toBe('created');
  const space = await named('Client - Rosario');
  expect(space).toBeDefined();
  expect(space!.slug).toBe('rosario');
  expect(said()).toContain('Created the Space');
});

it('gives it the standard two lists', async () => {
  await handleNewSpaceCommand(deps(), cmd('new Rosario') as never, 'Rosario');
  const space = await named('Rosario');
  const { rows } = await db.query<{ name: string }>(
    `SELECT name FROM lists WHERE space_id = $1 ORDER BY name`, [space!.id]
  );
  expect(rows.map((x) => x.name)).toEqual(['Open', 'Waiting / Blocked']);
});

it('reports an existing Space without creating a second one', async () => {
  const r = await handleNewSpaceCommand(deps(), cmd('new marketing') as never, 'marketing');
  expect(r.outcome).toBe('existed');
  expect(said()).toContain('already exists');
  expect((await listSpaces(db)).filter((s) => s.slug === 'marketing')).toHaveLength(1);
});

it('reports a name with no letters or digits', async () => {
  const r = await handleNewSpaceCommand(deps(), cmd('new !!!') as never, '!!!');
  expect(r.outcome).toBe('invalid');
  expect(said()).toBeTruthy();
});

it('refuses an unauthorized user and creates nothing', async () => {
  const body = { ...cmd('new Rosario'), user_id: 'U_OTHER' };
  const r = await handleNewSpaceCommand(deps(), body as never, 'Rosario');
  expect(r.outcome).toBe('unauthorized');
  expect(await named('Rosario')).toBeUndefined();
});

it('does not fail the creation when the confirmation message fails', async () => {
  client.chat.postEphemeral = vi.fn().mockRejectedValue(new Error('channel_not_found'));
  const r = await handleNewSpaceCommand(deps(), cmd('new Rosario') as never, 'Rosario');
  expect(r.outcome).toBe('created');
  expect(await named('Rosario')).toBeDefined();
});

// --- reached through /tasks ---

it('/tasks new <name> creates a Space rather than searching for one', async () => {
  const r = await handleTasksCommand(deps(), cmd('new Client - Rosario') as never);
  expect(r.scope).toBe('new-space');
  expect(await named('Client - Rosario')).toBeDefined();
  // Not posted as a task list.
  expect(client.chat.postMessage).not.toHaveBeenCalled();
});

it('/tasks <space> still searches, and is not caught by the subcommand', async () => {
  const r = await handleTasksCommand(deps(), cmd('marketing') as never);
  expect(r.scope).toBe('marketing');
});

it('an unknown scope names all three admin subcommands', async () => {
  await handleTasksCommand(deps(), cmd('nonsense-xyz') as never);
  const text = said();
  expect(text).toContain('/tasks map');
  expect(text).toContain('/tasks new');
});
