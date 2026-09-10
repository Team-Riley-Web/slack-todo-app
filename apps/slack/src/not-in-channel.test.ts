import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { listSpaces, mapChannelToSpace, getTask, createSpace } from '@tr/task-core';
import { handleTaskCommand } from './handlers/task-command.js';
import { handleMapCommand } from './handlers/map-command.js';
import { handleNewSpaceCommand } from './handlers/space-command.js';
import {
  isCannotPostError, slackErrorCode, cannotPostHere, replyPrivately,
} from './reply.js';

/**
 * The reported bug: `/space` then `/task` in #finances created the Space and
 * the task -- both visible in the web UI -- and said nothing at all in Slack.
 *
 * Cause: the app had never been invited to #finances, so `chat.postMessage`
 * failed with `not_in_channel` and `chat.postEphemeral` would have failed the
 * same way. `/task` threw after the task was already written; `/space` had
 * its confirmation wrapped in a bare `catch {}`. Either way: silence, and a
 * database that disagreed with what the person saw.
 *
 * These tests pin the fix: capture still succeeds, and the person is told,
 * through the command's response_url, which needs no channel membership.
 */

/** What Bolt's WebClient throws when the app is not in the channel. */
const notInChannel = () =>
  Object.assign(new Error('An API error occurred: not_in_channel'), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error: 'not_in_channel' },
  });

let db: Db;
const respond = vi.fn();
const client = {
  views: { open: vi.fn() },
  chat: { postMessage: vi.fn(), postEphemeral: vi.fn() },
};
const config = {
  teamId: 'T_RILEY', authorizedUserIds: ['U_JOSH'], defaultAssigneeId: 'U_JOSH',
  assigneeLabels: { U_JOSH: 'Joshua' }, timeZone: 'America/Chicago',
  mode: 'socket' as const,
};
const deps = () => ({ db, client: client as never, respond, config });

beforeEach(async () => {
  db = await createTestDb();
  respond.mockReset().mockResolvedValue({ ok: true });
  client.views.open = vi.fn().mockResolvedValue({ ok: true });
  client.chat.postMessage = vi.fn().mockRejectedValue(notInChannel());
  client.chat.postEphemeral = vi.fn().mockRejectedValue(notInChannel());
});
afterEach(async () => { await db.close(); });

const cmd = (over: Record<string, unknown> = {}) => ({
  text: '', channel_id: 'C_FINANCES', channel_name: 'finances',
  user_id: 'U_JOSH', team_id: 'T_RILEY', trigger_id: 'TRIG', ...over,
});

const said = () => respond.mock.calls.map((c) => String(c[0].text)).join('\n');

// --- the error classifier ---

it('reads the Slack error code out of a thrown WebAPI error', () => {
  expect(slackErrorCode(notInChannel())).toBe('not_in_channel');
  // A flatter shape, in case something other than Bolt raises it.
  expect(slackErrorCode({ error: 'is_archived' })).toBe('is_archived');
  expect(slackErrorCode(new Error('boom'))).toBeNull();
  expect(slackErrorCode(null)).toBeNull();
});

it('treats every cannot-post code as the same outcome, and nothing else', () => {
  for (const code of [
    'not_in_channel', 'channel_not_found', 'is_archived', 'restricted_action',
  ]) {
    expect(isCannotPostError({ data: { error: code } }), code).toBe(true);
  }
  // A real fault must still surface rather than be reported as a permission
  // problem and swallowed.
  for (const code of ['invalid_blocks', 'rate_limited', 'internal_error']) {
    expect(isCannotPostError({ data: { error: code } }), code).toBe(false);
  }
  expect(isCannotPostError(new Error('network down'))).toBe(false);
});

// --- /task ---

it('still creates the task when the app cannot post in the channel', async () => {
  await createSpace(db, 'Finances');
  await mapChannelToSpace(db, {
    channelId: 'C_FINANCES', channelName: '#finances', spaceName: 'Finances',
  });
  const r = await handleTaskCommand(deps(), cmd({ text: 'Move the funds' }) as never);

  expect(r.created).not.toBeNull();
  expect(r.created!.title).toBe('Move the funds');
  expect((await getTask(db, r.created!.id))!.title).toBe('Move the funds');
});

it('does not throw, so the command completes instead of dying after the write', async () => {
  // This is the actual regression: the throw happened AFTER createTask, so
  // the task existed and the person saw nothing.
  await expect(
    handleTaskCommand(deps(), cmd({ text: 'Move the funds' }) as never)
  ).resolves.toBeTruthy();
});

it('tells the person, via response_url, that it saved the task and cannot post', async () => {
  await createSpace(db, 'Finances');
  await mapChannelToSpace(db, {
    channelId: 'C_FINANCES', channelName: '#finances', spaceName: 'Finances',
  });
  const r = await handleTaskCommand(deps(), cmd({ text: 'Move the funds' }) as never);

  expect(r.reason).toBe('cannot_post_in_channel');
  expect(respond).toHaveBeenCalled();
  const text = said();
  expect(text).toContain('Move the funds');
  expect(text).toContain('Finances');
  expect(text).toContain('#finances');
  expect(text).toContain('/invite');
});

it('records no card and no message ts when nothing was posted', async () => {
  const r = await handleTaskCommand(deps(), cmd({ text: 'Move the funds' }) as never);
  expect((await getTask(db, r.created!.id))!.source_message_ts).toBeNull();
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM slack_cards`
  );
  expect(rows[0]!.n).toBe(0);
});

it('still raises a genuine posting fault rather than reporting it as permissions', async () => {
  client.chat.postMessage = vi.fn().mockRejectedValue(
    Object.assign(new Error('bad blocks'), { data: { ok: false, error: 'invalid_blocks' } })
  );
  await expect(
    handleTaskCommand(deps(), cmd({ text: 'Move the funds' }) as never)
  ).rejects.toThrow();
});

// --- /space ---

it('confirms a created Space through response_url, not into a void', async () => {
  const r = await handleNewSpaceCommand(deps() as never, cmd() as never, 'Finances');
  expect(r.outcome).toBe('created');
  expect(said()).toContain('Finances');
  expect((await listSpaces(db)).some((s) => s.name === 'Finances')).toBe(true);
});

it('confirms the channel mapping through response_url', async () => {
  await handleMapCommand(deps() as never, cmd({ text: 'Finances' }) as never);
  // Either it mapped and said so, or it opened the modal; what must not
  // happen is silence while the mapping changed.
  const opened = client.views.open.mock.calls.length > 0;
  expect(opened || respond.mock.calls.length > 0).toBe(true);
});

// --- the reply helper itself ---

it('prefers response_url and never falls through to a failing ephemeral', async () => {
  await replyPrivately(deps(), { channelId: 'C_FINANCES', userId: 'U_JOSH' }, 'hi');
  expect(respond).toHaveBeenCalledOnce();
  expect(client.chat.postEphemeral).not.toHaveBeenCalled();
});

it('falls back to postEphemeral when there is no response_url', async () => {
  client.chat.postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  await replyPrivately(
    { client: client as never }, { channelId: 'C_FINANCES', userId: 'U_JOSH' }, 'hi'
  );
  expect(client.chat.postEphemeral).toHaveBeenCalledOnce();
});

it('never throws, even when every delivery path fails', async () => {
  respond.mockRejectedValue(new Error('gone'));
  await expect(
    replyPrivately(deps(), { channelId: 'C_FINANCES', userId: 'U_JOSH' }, 'hi')
  ).resolves.toBeUndefined();
});

it('names the channel in the message, and says the work is saved', () => {
  const text = cannotPostHere('Saved *x*.', 'finances');
  expect(text).toContain('#finances');
  expect(text).toContain('saved');
  expect(text).toContain('/invite');
  // Without a channel name it still reads as a sentence.
  expect(cannotPostHere('Saved *x*.', undefined)).toContain('this channel');
});
