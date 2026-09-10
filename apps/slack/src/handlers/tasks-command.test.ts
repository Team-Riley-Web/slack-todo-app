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

// Required tests 9, 12. Counts now live behind `/tasks summary`; bare `/tasks`
// lists the tasks themselves.
it('summarizes counts per space, excluding completed tasks', async () => {
  const done = await add('Agency / Internal', 'Done');
  await add('Agency / Internal', 'A');
  await add('Marketing', 'B');
  await completeTask(db, done.id, actor);

  await handleTasksCommand(deps(), cmd('summary') as never);
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
  await handleTasksCommand(deps(), cmd('summary') as never);
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

// --- Phase 2: channel-aware context ---

const mapChannel = (channelId: string, name: string, space: string) =>
  db.query(
    `INSERT INTO channel_space_map (slack_channel_id, slack_channel_name, space_id)
     SELECT $1, $2, id FROM spaces WHERE name = $3`,
    [channelId, name, space]
  );

it('defaults bare /tasks to the mapped Space of the channel it was run in', async () => {
  await mapChannel('C_SECURE', '#client-secure-logic', 'Client - Secure Logic');
  await add('Client - Secure Logic', 'Give Rachael access to Marty photos');
  await add('Marketing', 'Unrelated marketing task');

  const r = await handleTasksCommand(deps(), cmd('', { channel_id: 'C_SECURE' }) as never);
  expect(r.scope).toBe('secure-logic');
  expect(r.count).toBe(1);
  const out = posted();
  expect(out).toContain('Give Rachael access to Marty photos');
  expect(out).not.toContain('Unrelated marketing task');
  expect(out).toContain('CLIENT - SECURE LOGIC');
});

it('returns interactive checkboxes in the channel-defaulted view', async () => {
  await mapChannel('C_AGENCY2', '#agency-ops', 'Agency / Internal');
  await add('Agency / Internal', 'Complete GMB verification');
  await handleTasksCommand(deps(), cmd('', { channel_id: 'C_AGENCY2' }) as never);
  expect(posted()).toContain('checkboxes');
});

it('lists every task from an unmapped channel, rather than counts', async () => {
  // This used to answer with "Marketing: 1 open", which told you a task
  // existed without letting you tick it off.
  await add('Marketing', 'Mkt task');
  await add('Sales', 'Sales task');
  const r = await handleTasksCommand(deps(), cmd('', { channel_id: 'C_UNMAPPED' }) as never);
  expect(r.scope).toBe('all');
  expect(r.count).toBe(2);
  const out = posted();
  expect(out).toContain('Mkt task');
  expect(out).toContain('Sales task');
  expect(out).toContain('checkboxes');
});

it('groups the everything view by Space, each Space once', async () => {
  await add('Marketing', 'Mkt one');
  await add('Marketing', 'Mkt two');
  await add('Sales', 'Sales one');
  await handleTasksCommand(deps(), cmd('', { channel_id: 'C_UNMAPPED' }) as never);

  const blocks = (client.chat.postMessage.mock.calls[0]![0] as any).blocks as any[];
  const headings = blocks.filter((b) => b.type === 'header').map((b) => b.text.text);
  expect(headings).toEqual(['MARKETING', 'SALES']);
});

it('says nothing open, ephemerally, when there are no tasks at all', async () => {
  const r = await handleTasksCommand(deps(), cmd('', { channel_id: 'C_UNMAPPED' }) as never);
  expect(r.count).toBe(0);
  expect(client.chat.postMessage).not.toHaveBeenCalled();
  expect(posted()).toContain('Nothing open');
});

it('excludes completed and waiting from the everything view', async () => {
  const done = await add('Marketing', 'Done task');
  const wait = await add('Sales', 'Waiting task');
  await add('Music', 'Open task');
  await completeTask(db, done.id, actor);
  await moveTask(db, wait.id, { status: 'waiting' }, actor);

  const r = await handleTasksCommand(deps(), cmd('', { channel_id: 'C_UNMAPPED' }) as never);
  expect(r.count).toBe(1);
  const out = posted();
  expect(out).toContain('Open task');
  expect(out).not.toContain('Done task');
  expect(out).not.toContain('Waiting task');
});

it('shows every Space with /tasks all, even from a mapped channel', async () => {
  await mapChannel('C_SECURE', '#client-secure-logic', 'Client - Secure Logic');
  await add('Client - Secure Logic', 'Secure task');
  await add('Marketing', 'Mkt task');
  const r = await handleTasksCommand(deps(), cmd('all', { channel_id: 'C_SECURE' }) as never);
  expect(r.scope).toBe('all');
  const out = posted();
  expect(out).toContain('Secure task');
  expect(out).toContain('Mkt task');
});

it('still offers counts on request, from anywhere', async () => {
  await mapChannel('C_SECURE', '#client-secure-logic', 'Client - Secure Logic');
  await add('Marketing', 'Mkt task');
  const r = await handleTasksCommand(deps(), cmd('summary', { channel_id: 'C_SECURE' }) as never);
  expect(r.scope).toBe('summary');
  expect(posted()).toContain('MY TASKS');
});

it('lets an explicit scope override the channel mapping', async () => {
  await mapChannel('C_SECURE', '#client-secure-logic', 'Client - Secure Logic');
  await add('Client - Secure Logic', 'Secure task');
  await add('Marketing', 'Mkt task');
  const r = await handleTasksCommand(deps(), cmd('marketing', { channel_id: 'C_SECURE' }) as never);
  expect(r.scope).toBe('marketing');
  const out = posted();
  expect(out).toContain('Mkt task');
  expect(out).not.toContain('Secure task');
});

it('still shows waiting from a mapped channel when asked', async () => {
  await mapChannel('C_SECURE', '#client-secure-logic', 'Client - Secure Logic');
  const w = await add('Client - Secure Logic', 'Waiting task');
  await moveTask(db, w.id, { status: 'waiting' }, actor);
  const r = await handleTasksCommand(deps(), cmd('waiting', { channel_id: 'C_SECURE' }) as never);
  expect(r.scope).toBe('waiting');
  expect(r.count).toBe(1);
});

it('excludes waiting and completed from the channel-defaulted view', async () => {
  await mapChannel('C_SECURE', '#client-secure-logic', 'Client - Secure Logic');
  const w = await add('Client - Secure Logic', 'Waiting task');
  const c = await add('Client - Secure Logic', 'Done task');
  await add('Client - Secure Logic', 'Open task');
  await moveTask(db, w.id, { status: 'waiting' }, actor);
  await completeTask(db, c.id, actor);

  const r = await handleTasksCommand(deps(), cmd('', { channel_id: 'C_SECURE' }) as never);
  expect(r.count).toBe(1);
  const out = posted();
  expect(out).toContain('Open task');
  expect(out).not.toContain('Waiting task');
  expect(out).not.toContain('Done task');
});

it('never infers a Space from channel-name text when the channel is unmapped', async () => {
  await add('Client - Secure Logic', 'Secure task');
  // The channel id itself looks like a client channel, but has no mapping row.
  const r = await handleTasksCommand(
    deps(), cmd('', { channel_id: 'C_client_secure_logic' }) as never
  );
  // Every Space, not the one the channel id happens to spell.
  expect(r.scope).toBe('all');
  expect(posted()).toContain('Secure task');
});

// --- native Slack elements ---

it('renders the summary with a native header and section fields', async () => {
  await add('Agency / Internal', 'A');
  await add('Marketing', 'B');
  await handleTasksCommand(deps(), cmd('summary') as never);

  const arg = client.chat.postEphemeral.mock.calls[0]![0] as any;
  const blocks = arg.blocks as any[];
  expect(blocks[0].type).toBe('header');
  expect(blocks[0].text.type).toBe('plain_text');
  expect(blocks[0].text.text).toBe('MY TASKS');

  const section = blocks.find((b) => b.type === 'section' && Array.isArray(b.fields));
  expect(section).toBeDefined();
  expect(section.fields).toHaveLength(2);

  // the old hand-rolled form must be gone
  expect(JSON.stringify(blocks)).not.toContain('*MY TASKS*');
  // and a plain-text fallback still accompanies it for notifications
  expect(arg.text).toContain('MY TASKS');
});

it('renders a scoped list heading as a native header block', async () => {
  await add('Marketing', 'Mkt task');
  await handleTasksCommand(deps(), cmd('marketing') as never);
  const blocks = (client.chat.postMessage.mock.calls[0]![0] as any).blocks as any[];
  expect(blocks[0].type).toBe('header');
  expect(blocks[0].text.text).toBe('MARKETING');
  expect(JSON.stringify(blocks)).not.toContain('*MARKETING*');
});

it('posts every-Space blocks with unique block ids, which Slack requires', async () => {
  // Slack rejects the WHOLE message on a duplicate block_id, so this failed as
  // "invalid_blocks: task_toggle:0:v1 already exists" and rendered nothing at
  // all. Guarded at the handler too, not just in the block builder.
  for (const space of ['Marketing', 'Sales', 'Music', 'Personal', 'Agency / Internal']) {
    await add(space, `${space} task`);
  }
  await handleTasksCommand(deps(), cmd('', { channel_id: 'C_UNMAPPED' }) as never);

  const blocks = (client.chat.postMessage.mock.calls[0]![0] as any).blocks as any[];
  const ids = blocks.map((b) => b.block_id).filter(Boolean);
  expect(ids.length).toBeGreaterThan(1);
  expect(new Set(ids).size).toBe(ids.length);
  expect(blocks.length).toBeLessThanOrEqual(50);
});
