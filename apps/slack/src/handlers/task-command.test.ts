import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { mapChannelToSpace } from '@tr/task-core';
import { handleTaskCommand } from './task-command.js';

let db: Db;
const client = { chat: { postMessage: vi.fn(), postEphemeral: vi.fn() } };
const config = {
  teamId: 'T_RILEY', authorizedUserIds: [], defaultAssigneeId: 'U_JOSH',
  assigneeLabels: { U_JOSH: 'Joshua' }, timeZone: 'America/Chicago', mode: 'socket' as const,
};

beforeEach(async () => {
  db = await createTestDb();
  client.chat.postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1700000000.000200' });
  client.chat.postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  await db.query(
    `INSERT INTO channel_space_map (slack_channel_id, slack_channel_name, space_id)
     SELECT 'C_AGENCY', '#agency-ops', id FROM spaces WHERE name = 'Agency / Internal'`
  );
});
afterEach(async () => { await db.close(); });

const cmd = (text: string, over: Record<string, unknown> = {}) => ({
  text, channel_id: 'C_AGENCY', user_id: 'U_JOSH', team_id: 'T_RILEY', ...over,
});
const deps = () => ({ db, client: client as never, config });

const spaceOf = async (id: string) => {
  const { rows } = await db.query<{ name: string }>(
    `SELECT s.name FROM tasks t JOIN spaces s ON s.id = t.space_id WHERE t.id = $1`, [id]
  );
  return rows[0]!.name;
};

// Required tests 1, 4
it('stores the exact title and routes by channel mapping', async () => {
  const raw = 'Offer Neil Instagram and Facebook package for $100';
  const { created } = await handleTaskCommand(deps(), cmd(raw) as never);
  expect(created!.title).toBe(raw);
  expect(await spaceOf(created!.id)).toBe('Agency / Internal');
});

it('assigns the configured default assignee', async () => {
  const { created } = await handleTaskCommand(deps(), cmd('Call Neil') as never);
  expect(created!.assignee_id).toBe('U_JOSH');
});

it('records the Slack source of the capture', async () => {
  const { created } = await handleTaskCommand(deps(), cmd('Call Neil') as never);
  expect(created!.source_platform).toBe('slack');
  expect(created!.source_channel_id).toBe('C_AGENCY');
  expect(created!.created_by).toBe('U_JOSH');
});

// Required test 3
it('routes an unmapped channel to Inbox and says so', async () => {
  const { created } = await handleTaskCommand(
    deps(), cmd('Buy a new vehicle', { channel_id: 'C_NEW' }) as never
  );
  expect(await spaceOf(created!.id)).toBe('Inbox');
  expect(JSON.stringify(client.chat.postMessage.mock.calls[0]![0]!)).toContain('Inbox');
});

it('parses a strict due token without altering the remaining title', async () => {
  const { created } = await handleTaskCommand(deps(), cmd('Call Neil due:2026-09-15') as never);
  expect(created!.title).toBe('Call Neil');
  expect(created!.due_at).toBeInstanceOf(Date);
});

it('posts a native checkbox card and records it for later toggles', async () => {
  const { created } = await handleTaskCommand(deps(), cmd('Call Neil') as never);
  const arg = client.chat.postMessage.mock.calls[0]![0]!;
  const el = arg.blocks.find((b: any) => b.type === 'actions').elements[0];
  expect(el.type).toBe('checkboxes');
  expect(el.options[0].value).toBe(created!.id);

  const { rows } = await db.query<{ message_ts: string }>(
    `SELECT message_ts FROM slack_cards WHERE channel_id = 'C_AGENCY'`
  );
  expect(rows[0]!.message_ts).toBe('1700000000.000200');
});

it('records the source message ts on the task', async () => {
  const { created } = await handleTaskCommand(deps(), cmd('Call Neil') as never);
  const { rows } = await db.query<{ source_message_ts: string }>(
    `SELECT source_message_ts FROM tasks WHERE id = $1`, [created!.id]
  );
  expect(rows[0]!.source_message_ts).toBe('1700000000.000200');
});

it('rejects an empty command with an ephemeral message and no task', async () => {
  const r = await handleTaskCommand(deps(), cmd('   ') as never);
  expect(r.created).toBeNull();
  expect(client.chat.postMessage).not.toHaveBeenCalled();
  expect(client.chat.postEphemeral).toHaveBeenCalled();
});

// Required test 16
it('rejects an unauthorized workspace with no task created', async () => {
  const r = await handleTaskCommand(deps(), cmd('X', { team_id: 'T_OTHER' }) as never);
  expect(r.created).toBeNull();
  const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks`);
  expect(rows[0]!.n).toBe(0);
});

// --- a time written in the title ---

it('sets a due date from a time in the title and keeps the title byte-exact', async () => {
  const r = await handleTaskCommand(deps(), cmd('Call Andre at 3:30') as never);
  expect(r.created!.title).toBe('Call Andre at 3:30');
  expect(r.created!.due_at).not.toBeNull();
});

it('says outright that it inferred the due date', async () => {
  await handleTaskCommand(deps(), cmd('Call Andre at 3:30') as never);
  const arg = client.chat.postMessage.mock.calls[0]![0] as any;
  const context = (arg.blocks as any[]).find((b) => b.type === 'context');
  expect(JSON.stringify(context)).toContain('from the time in the title');
  // Rendered as a Slack date token, so each reader sees their own timezone.
  expect(JSON.stringify(context)).toContain('<!date^');
});

it('adds no due note when there is no time to read', async () => {
  await handleTaskCommand(deps(), cmd('Offer Neil a package for $100') as never);
  const arg = client.chat.postMessage.mock.calls[0]![0] as any;
  expect(JSON.stringify(arg.blocks)).not.toContain('from the time in the title');
});

it('does not read a due date out of a number that is not a time', async () => {
  const r = await handleTaskCommand(
    deps(), cmd('Consolidate 401(k): move Corebridge to Fidelity') as never
  );
  expect(r.created!.due_at).toBeNull();
  expect(r.created!.title).toBe('Consolidate 401(k): move Corebridge to Fidelity');
});

// --- the Space is not repeated when the channel already implies it ---

it('omits the Space on a card posted in the channel that routes there', async () => {
  await mapChannelToSpace(db, {
    channelId: 'C_MKT', channelName: '#marketing', spaceName: 'Marketing',
  });
  const r = await handleTaskCommand(
    deps(), cmd('Ship the landing page', { channel_id: 'C_MKT' }) as never
  );
  expect(r.created!.title).toBe('Ship the landing page');

  const arg = client.chat.postMessage.mock.calls[0]![0] as any;
  const option = (arg.blocks as any[])
    .find((b) => b.type === 'actions').elements[0].options[0];
  expect(option.description?.text ?? '').not.toContain('Marketing');
});

it('still names Inbox on a card from an unmapped channel, because that IS worth knowing', async () => {
  await handleTaskCommand(deps(), cmd('Something', { channel_id: 'C_NOWHERE' }) as never);
  const arg = client.chat.postMessage.mock.calls[0]![0] as any;
  const option = (arg.blocks as any[])
    .find((b) => b.type === 'actions').elements[0].options[0];
  expect(option.description.text).toContain('Inbox');
});
