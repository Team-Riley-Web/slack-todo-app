import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { getSpaceForChannel, listSpaces, mapChannelToSpace } from '@tr/task-core';
import { MAP_BLOCK, MAP_ACTION, MAP_NONE, MAP_CALLBACK_ID } from '@tr/slack-ui';
import {
  handleMapCommand, handleMapSubmission, isMapCommand,
} from './map-command.js';

let db: Db;
const client = { views: { open: vi.fn() }, chat: { postEphemeral: vi.fn() } };
const config = {
  teamId: 'T_RILEY', authorizedUserIds: ['U_JOSH'], defaultAssigneeId: null,
  assigneeLabels: {}, timeZone: 'America/Chicago', mode: 'socket' as const,
};
const deps = () => ({ db, client: client as never, config });

beforeEach(async () => {
  db = await createTestDb();
  client.views.open = vi.fn().mockResolvedValue({ ok: true });
  client.chat.postEphemeral = vi.fn().mockResolvedValue({ ok: true });
});
afterEach(async () => { await db.close(); });

const cmd = (over: Record<string, unknown> = {}) => ({
  text: 'map', channel_id: 'C_MKT', channel_name: 'marketing',
  user_id: 'U_JOSH', team_id: 'T_RILEY', trigger_id: 'TRIG', ...over,
});

const view = () => client.views.open.mock.calls[0]![0].view as any;

const submission = (value: string | null, over: Record<string, unknown> = {}) => ({
  team: { id: 'T_RILEY' },
  user: { id: 'U_JOSH' },
  view: {
    private_metadata: JSON.stringify({ channelId: 'C_MKT', channelName: '#marketing' }),
    state: {
      values: {
        [MAP_BLOCK]: {
          [MAP_ACTION]: value === null ? {} : { selected_option: { value } },
        },
      },
    },
  },
  ...over,
});

it('recognises only the exact word map as the subcommand', () => {
  expect(isMapCommand('map')).toBe(true);
  expect(isMapCommand(' MAP ')).toBe(true);
  expect(isMapCommand('marketing')).toBe(false);
  expect(isMapCommand('map marketing')).toBe(false);
  expect(isMapCommand('')).toBe(false);
  expect(isMapCommand(undefined)).toBe(false);
});

it('no seeded Space is named in a way the map subcommand would swallow', async () => {
  // The subcommand only shadows a Space actually called "map". Asserted rather
  // than assumed, so seeding one later fails here instead of in Slack.
  const names = (await listSpaces(db)).map((s) => s.name.toLowerCase());
  expect(names).not.toContain('map');
  const slugs = (await listSpaces(db)).map((s) => s.slug.toLowerCase());
  expect(slugs).not.toContain('map');
});

it('opens a modal listing every Space plus a none option', async () => {
  const result = await handleMapCommand(deps(), cmd() as never);
  expect(result.outcome).toBe('opened');

  const v = view();
  expect(v.callback_id).toBe(MAP_CALLBACK_ID);
  const options = v.blocks.find((b: any) => b.block_id === MAP_BLOCK).element.options;
  expect(options[0].value).toBe(MAP_NONE);
  expect(options).toHaveLength((await listSpaces(db)).length + 1);
});

it('defaults to none for an unmapped channel', async () => {
  await handleMapCommand(deps(), cmd() as never);
  const el = view().blocks.find((b: any) => b.block_id === MAP_BLOCK).element;
  expect(el.initial_option.value).toBe(MAP_NONE);
});

it('prefills the Space a mapped channel already uses', async () => {
  await mapChannelToSpace(db, {
    channelId: 'C_MKT', channelName: '#marketing', spaceName: 'Marketing',
  });
  await handleMapCommand(deps(), cmd() as never);
  const el = view().blocks.find((b: any) => b.block_id === MAP_BLOCK).element;
  expect(el.initial_option.value).toBe('Marketing');
});

it('reuses the same option object for initial_option, which Slack matches by identity', async () => {
  await mapChannelToSpace(db, { channelId: 'C_MKT', spaceName: 'Marketing' });
  await handleMapCommand(deps(), cmd() as never);
  const el = view().blocks.find((b: any) => b.block_id === MAP_BLOCK).element;
  expect(el.options).toContain(el.initial_option);
});

it('shows the channel name with a hash, the way the sidebar does', async () => {
  await handleMapCommand(deps(), cmd() as never);
  expect(JSON.stringify(view())).toContain('#marketing');
});

it('refuses an unauthorized user and opens nothing', async () => {
  const result = await handleMapCommand(deps(), cmd({ user_id: 'U_OTHER' }) as never);
  expect(result.outcome).toBe('unauthorized');
  expect(client.views.open).not.toHaveBeenCalled();
});

it('maps the channel on submit and confirms ephemerally', async () => {
  const result = await handleMapSubmission(deps(), submission('Marketing'));
  expect(result.outcome).toBe('mapped');

  const context = await getSpaceForChannel(db, 'C_MKT');
  expect(context.mapped).toBe(true);
  expect(context.space.name).toBe('Marketing');
  expect(String(client.chat.postEphemeral.mock.calls[0]![0].text)).toContain('Marketing');
});

it('remaps rather than duplicating', async () => {
  await handleMapSubmission(deps(), submission('Marketing'));
  await handleMapSubmission(deps(), submission('Sales'));
  expect((await getSpaceForChannel(db, 'C_MKT')).space.name).toBe('Sales');
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM channel_space_map WHERE slack_channel_id = 'C_MKT'`
  );
  expect(rows[0]!.n).toBe(1);
});

it('unmaps when none is chosen', async () => {
  await handleMapSubmission(deps(), submission('Marketing'));
  const result = await handleMapSubmission(deps(), submission(MAP_NONE));
  expect(result.outcome).toBe('unmapped');
  expect((await getSpaceForChannel(db, 'C_MKT')).mapped).toBe(false);
});

it('treats unmapping an unmapped channel as unchanged, not an error', async () => {
  const result = await handleMapSubmission(deps(), submission(MAP_NONE));
  expect(result.outcome).toBe('unchanged');
});

it('returns a native field error for a Space that does not exist', async () => {
  const result = await handleMapSubmission(deps(), submission('Nowhere Client'));
  expect(result.outcome).toBe('invalid');
  expect(result.error?.blockId).toBe(MAP_BLOCK);
  expect((await getSpaceForChannel(db, 'C_MKT')).mapped).toBe(false);
});

it('refuses an unauthorized submission and changes nothing', async () => {
  const body = { ...submission('Marketing'), team: { id: 'T_OTHER' } };
  expect((await handleMapSubmission(deps(), body)).outcome).toBe('unauthorized');
  expect((await getSpaceForChannel(db, 'C_MKT')).mapped).toBe(false);
});

it('survives unparseable metadata without writing', async () => {
  const body = {
    team: { id: 'T_RILEY' }, user: { id: 'U_JOSH' },
    view: { private_metadata: 'not json', state: { values: {} } },
  };
  expect((await handleMapSubmission(deps(), body)).outcome).toBe('invalid');
});

it('does not fail the mapping when the confirmation message fails', async () => {
  client.chat.postEphemeral = vi.fn().mockRejectedValue(new Error('channel_not_found'));
  const result = await handleMapSubmission(deps(), submission('Marketing'));
  expect(result.outcome).toBe('mapped');
  expect((await getSpaceForChannel(db, 'C_MKT')).mapped).toBe(true);
});
