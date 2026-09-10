import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { listSpaces, mapChannelToSpace, getTask } from '@tr/task-core';
import { CAPTURE_BLOCKS, CAPTURE_CALLBACK_ID } from '@tr/slack-ui';
import { handleCaptureOpen, handleCaptureSubmission } from './capture-modal.js';
import { handleTaskCommand } from './task-command.js';

let db: Db;
const client = {
  views: { open: vi.fn() },
  chat: { postMessage: vi.fn(), postEphemeral: vi.fn() },
};
const config = {
  teamId: 'T_RILEY', authorizedUserIds: ['U_JOSH'], defaultAssigneeId: 'U_JOSH',
  assigneeLabels: { U_JOSH: 'Joshua' }, timeZone: 'America/Chicago', mode: 'socket' as const,
};
const deps = () => ({ db, client: client as never, config });

beforeEach(async () => {
  db = await createTestDb();
  client.views.open = vi.fn().mockResolvedValue({ ok: true });
  client.chat.postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1700.0001' });
  client.chat.postEphemeral = vi.fn().mockResolvedValue({ ok: true });
});
afterEach(async () => { await db.close(); });

const cmd = (over: Record<string, unknown> = {}) => ({
  text: '', channel_id: 'C_AGENCY', channel_name: 'agency-ops',
  user_id: 'U_JOSH', team_id: 'T_RILEY', trigger_id: 'TRIG', ...over,
});

const view = () => client.views.open.mock.calls[0]![0].view as any;
const blockOf = (v: any, id: string) =>
  v.blocks.find((b: any) => b.block_id === id);

const submit = (fields: {
  title?: string; spaceId?: string | null; newSpace?: string;
  status?: 'open' | 'waiting'; assignee?: string; due?: number; details?: string;
  channelId?: string; defaultSpaceId?: string | null;
}) => ({
  team: { id: 'T_RILEY' },
  user: { id: 'U_JOSH' },
  view: {
    private_metadata: JSON.stringify({
      channelId: fields.channelId ?? 'C_AGENCY',
      defaultSpaceId: fields.defaultSpaceId ?? null,
    }),
    state: {
      values: {
        [CAPTURE_BLOCKS.title]: { title: { value: fields.title ?? 'A task' } },
        [CAPTURE_BLOCKS.space]: {
          space: fields.spaceId
            ? { selected_option: { value: fields.spaceId } }
            : {},
        },
        [CAPTURE_BLOCKS.newSpace]: { new_space: { value: fields.newSpace ?? null } },
        [CAPTURE_BLOCKS.status]: {
          status: { selected_option: { value: fields.status ?? 'open' } },
        },
        [CAPTURE_BLOCKS.assignee]: { assignee: { selected_user: fields.assignee ?? null } },
        [CAPTURE_BLOCKS.due]: { due: { selected_date_time: fields.due ?? null } },
        [CAPTURE_BLOCKS.details]: { details: { value: fields.details ?? null } },
      },
    },
  },
});

const spaceNamed = async (name: string) =>
  (await listSpaces(db)).find((s) => s.name === name)!;

// --- opening ---

it('opens the modal on a bare /task instead of printing the syntax', async () => {
  const r = await handleTaskCommand(deps(), cmd() as never);
  expect(r.reason).toBe('opened_modal');
  expect(client.views.open).toHaveBeenCalled();
  expect(view().callback_id).toBe(CAPTURE_CALLBACK_ID);
  expect(client.chat.postEphemeral).not.toHaveBeenCalled();
});

it('leaves the one-line fast path alone', async () => {
  const r = await handleTaskCommand(deps(), cmd({ text: 'Call Neil' }) as never);
  expect(r.created!.title).toBe('Call Neil');
  expect(client.views.open).not.toHaveBeenCalled();
});

it('preselects the Space the channel maps to', async () => {
  await mapChannelToSpace(db, {
    channelId: 'C_AGENCY', channelName: '#agency-ops', spaceName: 'Agency / Internal',
  });
  const agency = await spaceNamed('Agency / Internal');
  await handleCaptureOpen(deps(), cmd() as never);
  expect(blockOf(view(), CAPTURE_BLOCKS.space).element.initial_option.value)
    .toBe(agency.id);
});

it('reuses the same option object for initial_option', async () => {
  await mapChannelToSpace(db, {
    channelId: 'C_AGENCY', spaceName: 'Agency / Internal',
  });
  await handleCaptureOpen(deps(), cmd() as never);
  const el = blockOf(view(), CAPTURE_BLOCKS.space).element;
  // option_groups, so the options are one level deeper.
  const options = (el.option_groups as any[]).flatMap((g) => g.options);
  expect(options).toContain(el.initial_option);
});

it('groups clients separately in the Space picker', async () => {
  await handleCaptureOpen(deps(), cmd() as never);
  const el = blockOf(view(), CAPTURE_BLOCKS.space).element;
  expect((el.option_groups as any[]).map((g) => g.label.text))
    .toEqual(['Spaces', 'Clients']);
});

it('offers a new-Space field that is optional', async () => {
  await handleCaptureOpen(deps(), cmd() as never);
  const block = blockOf(view(), CAPTURE_BLOCKS.newSpace);
  expect(block.optional).toBe(true);
  expect(block.element.type).toBe('plain_text_input');
});

it('does not offer completed as a status for a task being created', async () => {
  await handleCaptureOpen(deps(), cmd() as never);
  const values = blockOf(view(), CAPTURE_BLOCKS.status).element.options
    .map((o: any) => o.value);
  expect(values).toEqual(['open', 'waiting']);
});

it('refuses to open for an unauthorized user', async () => {
  const r = await handleCaptureOpen(deps(), cmd({ user_id: 'U_OTHER' }) as never);
  expect(r.outcome).toBe('unauthorized');
  expect(client.views.open).not.toHaveBeenCalled();
});

// --- submitting ---

it('creates the task with the title byte-exact', async () => {
  const marketing = await spaceNamed('Marketing');
  const r = await handleCaptureSubmission(
    deps(), submit({ title: 'Offer Neil a package for $100', spaceId: marketing.id })
  );
  expect(r.created!.title).toBe('Offer Neil a package for $100');
  expect(r.created!.space_id).toBe(marketing.id);
});

it('creates a new Space from the text field and puts the task in it', async () => {
  // The reason this exists: a new client should not mean leaving the modal.
  const r = await handleCaptureSubmission(
    deps(),
    submit({ title: 'Kick off the site', newSpace: 'Client - Rosario Landscaping' })
  );
  expect(r.spaceCreated!.name).toBe('Client - Rosario Landscaping');
  expect(r.spaceCreated!.slug).toBe('rosario-landscaping');
  expect(r.created!.space_id).toBe(r.spaceCreated!.id);
  expect(JSON.stringify(client.chat.postMessage.mock.calls[0]![0]))
    .toContain('Created the Space');
});

it('gives a new Space the same two lists every seeded Space has', async () => {
  const r = await handleCaptureSubmission(
    deps(), submit({ title: 'x', newSpace: 'Client - Rosario Landscaping' })
  );
  const { rows } = await db.query<{ name: string }>(
    `SELECT name FROM lists WHERE space_id = $1 ORDER BY name`,
    [r.spaceCreated!.id]
  );
  expect(rows.map((x) => x.name)).toEqual(['Open', 'Waiting / Blocked']);
});

it('reuses an existing Space rather than failing on the name', async () => {
  const r = await handleCaptureSubmission(
    deps(), submit({ title: 'x', newSpace: 'marketing' })
  );
  const marketing = await spaceNamed('Marketing');
  expect(r.created!.space_id).toBe(marketing.id);
  // Nothing was created, so nothing is announced.
  expect(r.spaceCreated).toBeNull();
  expect((await listSpaces(db)).filter((s) => s.slug === 'marketing')).toHaveLength(1);
});

it('lets the typed name override the picker', async () => {
  const marketing = await spaceNamed('Marketing');
  const r = await handleCaptureSubmission(
    deps(),
    submit({ title: 'x', spaceId: marketing.id, newSpace: 'Client - Rosario Landscaping' })
  );
  expect(r.created!.space_id).toBe(r.spaceCreated!.id);
  expect(r.created!.space_id).not.toBe(marketing.id);
});

it('records a waiting status as its own audited event', async () => {
  const marketing = await spaceNamed('Marketing');
  const r = await handleCaptureSubmission(
    deps(), submit({ title: 'x', spaceId: marketing.id, status: 'waiting' })
  );
  expect((await getTask(db, r.created!.id))!.status).toBe('waiting');
  const { rows } = await db.query<{ event: string }>(
    `SELECT event FROM task_events WHERE task_id = $1 ORDER BY id`, [r.created!.id]
  );
  expect(rows.map((x) => x.event)).toEqual(['created', 'moved']);
});

it('stores details verbatim', async () => {
  const marketing = await spaceNamed('Marketing');
  const details = 'Line one\n  indented\n\nblank above';
  const r = await handleCaptureSubmission(
    deps(), submit({ title: 'x', spaceId: marketing.id, details })
  );
  expect((await getTask(db, r.created!.id))!.details).toBe(details);
});

it('applies a due date from the picker', async () => {
  const marketing = await spaceNamed('Marketing');
  const when = Math.floor(Date.UTC(2026, 10, 13, 15, 0, 0) / 1000);
  const r = await handleCaptureSubmission(
    deps(), submit({ title: 'x', spaceId: marketing.id, due: when })
  );
  expect(r.created!.due_at!.getTime()).toBe(when * 1000);
});

it('returns a field error for an empty title and creates nothing', async () => {
  const marketing = await spaceNamed('Marketing');
  const r = await handleCaptureSubmission(
    deps(), submit({ title: '   ', spaceId: marketing.id })
  );
  expect(r.error?.blockId).toBe(CAPTURE_BLOCKS.title);
  expect(r.created).toBeNull();
  const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks`);
  expect(rows[0]!.n).toBe(0);
});

it('returns a field error when neither a Space nor a new name is given', async () => {
  const r = await handleCaptureSubmission(deps(), submit({ title: 'x' }));
  expect(r.error?.blockId).toBe(CAPTURE_BLOCKS.space);
  expect(r.created).toBeNull();
});

it('errors on the new-Space field for a name with no letters or digits', async () => {
  const r = await handleCaptureSubmission(
    deps(), submit({ title: 'x', newSpace: '!!!' })
  );
  expect(r.error?.blockId).toBe(CAPTURE_BLOCKS.newSpace);
  expect(r.created).toBeNull();
});

it('refuses an unauthorized submission and creates nothing', async () => {
  const marketing = await spaceNamed('Marketing');
  const body = { ...submit({ title: 'x', spaceId: marketing.id }), team: { id: 'T_OTHER' } };
  const r = await handleCaptureSubmission(deps(), body);
  expect(r.created).toBeNull();
  const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks`);
  expect(rows[0]!.n).toBe(0);
});

it('posts a card and records it, so the checkbox works straight away', async () => {
  const marketing = await spaceNamed('Marketing');
  const r = await handleCaptureSubmission(
    deps(), submit({ title: 'Tick me', spaceId: marketing.id })
  );
  const { rows } = await db.query<{ task_ids: string[] }>(
    `SELECT task_ids FROM slack_cards WHERE message_ts = '1700.0001'`
  );
  expect(rows[0]!.task_ids).toEqual([r.created!.id]);
});
