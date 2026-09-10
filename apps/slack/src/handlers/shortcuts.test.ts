import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask, completeTask, moveTask, getTask, type Task } from '@tr/task-core';
import { saveCard } from '@tr/slack-sync';
import { PICKER_BLOCK, PICKER_ACTION, PICKER_CALLBACK_ID } from '@tr/slack-ui';
import {
  handleTaskShortcut, handlePickerSubmission, SHORTCUT_IDS,
} from './shortcuts.js';

let db: Db;
const spaceIds: Record<string, string> = {};
const client = {
  chat: {
    postMessage: vi.fn(), postEphemeral: vi.fn(), update: vi.fn(),
  },
  views: { open: vi.fn() },
};
const config = {
  teamId: 'T_RILEY', authorizedUserIds: [], defaultAssigneeId: 'U_JOSH',
  assigneeLabels: { U_JOSH: 'Joshua' }, timeZone: 'America/Chicago', mode: 'socket' as const,
};
const actor = { id: 'U_JOSH', source: 'test' };
const deps = () => ({ db, client: client as never, config });

const CHANNEL = 'C_AGENCY';
const TS = '1700000000.000100';

beforeEach(async () => {
  db = await createTestDb();
  client.chat.postMessage = vi.fn().mockResolvedValue({ ok: true, ts: TS });
  client.chat.postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  client.chat.update = vi.fn().mockResolvedValue({ ok: true });
  client.views.open = vi.fn().mockResolvedValue({ ok: true });
  const { rows } = await db.query<{ id: string; name: string }>(`SELECT id, name FROM spaces`);
  for (const r of rows) spaceIds[r.name] = r.id;
});
afterEach(async () => { await db.close(); });

const add = (space: string, title: string) =>
  createTask(db, { title, spaceId: spaceIds[space]!, assigneeId: 'U_JOSH' });

/** getTask is nullable; in these tests the task always exists. */
const fetch1 = async (id: string): Promise<Task> => (await getTask(db, id))!;

const card = async (tasks: Task[], ts = TS): Promise<void> => {
  const spaces = new Map(
    Object.entries(spaceIds).map(([name, id]) => [id, { id, name, slug: name, is_inbox: false }])
  );
  await saveCard(db, {
    channelId: CHANNEL, messageTs: ts,
    entries: tasks.map((task) => ({ task, space: spaces.get(task.space_id) as never })),
    viewScope: 'all',
  });
};

/** A message_action payload, as Slack documents it. */
const shortcut = (over: Record<string, unknown> = {}) => ({
  type: 'message_action',
  callback_id: SHORTCUT_IDS.edit,
  trigger_id: 'TRIG',
  team: { id: 'T_RILEY' },
  user: { id: 'U_JOSH' },
  channel: { id: CHANNEL },
  message: { ts: TS },
  ...over,
});

it('has callback ids that match the manifest', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = await readFile('config/slack-app-manifest.yaml', 'utf8');
  expect(manifest).toContain(`callback_id: ${SHORTCUT_IDS.edit}`);
  expect(manifest).toContain(`callback_id: ${SHORTCUT_IDS.waiting}`);
  expect(manifest).toContain('type: message');
});

it('opens the edit modal directly for a single-task card', async () => {
  const task = await add('Marketing', 'Only task');
  await card([task]);

  const r = await handleTaskShortcut(deps(), 'edit', shortcut());
  expect(r.outcome).toBe('opened_edit');

  const view = client.views.open.mock.calls[0]![0].view;
  expect(view.callback_id).toBe('task_edit_modal');
  expect(JSON.parse(view.private_metadata).taskId).toBe(task.id);
});

it('toggles waiting directly for a single-task card, and redraws it', async () => {
  const task = await add('Marketing', 'Only task');
  await card([task]);

  const r = await handleTaskShortcut(
    deps(), 'waiting', shortcut({ callback_id: SHORTCUT_IDS.waiting })
  );
  expect(r.outcome).toBe('applied');
  expect((await fetch1(task.id)).status).toBe('waiting');
  expect(client.chat.update).toHaveBeenCalled();
});

it('toggles back to open, and clears waiting_on', async () => {
  const task = await add('Marketing', 'Only task');
  await moveTask(db, task.id, { status: 'waiting', waitingOn: 'the client' }, actor);
  await card([await fetch1(task.id)]);

  await handleTaskShortcut(deps(), 'waiting', shortcut({ callback_id: SHORTCUT_IDS.waiting }));
  const fresh = await fetch1(task.id);
  expect(fresh.status).toBe('open');
  expect(fresh.waiting_on).toBeNull();
});

it('refuses to move a completed task, since unticking is the reopen gesture', async () => {
  const task = await add('Marketing', 'Done');
  await completeTask(db, task.id, actor);
  await card([await fetch1(task.id)]);

  await handleTaskShortcut(deps(), 'waiting', shortcut({ callback_id: SHORTCUT_IDS.waiting }));
  expect((await fetch1(task.id)).status).toBe('completed');
  expect(String(client.chat.postEphemeral.mock.calls[0]![0].text)).toContain('Untick');
});

it('asks which task when the card holds several', async () => {
  const a = await add('Marketing', 'First task');
  const b = await add('Sales', 'Second task');
  await card([a, b]);

  const r = await handleTaskShortcut(deps(), 'edit', shortcut());
  expect(r.outcome).toBe('opened_picker');

  const view = client.views.open.mock.calls[0]![0].view;
  expect(view.callback_id).toBe(PICKER_CALLBACK_ID);
  const element = view.blocks[0].element;
  expect(element.type).toBe('radio_buttons');
  expect(element.options.map((o: any) => o.value)).toEqual([a.id, b.id]);
});

it('never acts on the first task when several are on the card', async () => {
  const a = await add('Marketing', 'First task');
  const b = await add('Sales', 'Second task');
  await card([a, b]);

  await handleTaskShortcut(deps(), 'waiting', shortcut({ callback_id: SHORTCUT_IDS.waiting }));
  expect((await fetch1(a.id)).status).toBe('open');
  expect((await fetch1(b.id)).status).toBe('open');
});

it('uses a select rather than radios above ten tasks', async () => {
  const tasks: Task[] = [];
  for (let i = 0; i < 12; i += 1) tasks.push(await add('Marketing', `Task ${i}`));
  await card(tasks);

  await handleTaskShortcut(deps(), 'edit', shortcut());
  const element = client.views.open.mock.calls[0]![0].view.blocks[0].element;
  expect(element.type).toBe('static_select');
});

it('explains itself on a message that is not a task card', async () => {
  const r = await handleTaskShortcut(deps(), 'edit', shortcut({ message: { ts: '999.999' } }));
  expect(r.outcome).toBe('unknown_card');
  expect(client.views.open).not.toHaveBeenCalled();
  expect(String(client.chat.postEphemeral.mock.calls[0]![0].text)).toContain('not a task card');
});

it('refuses an unauthorized workspace and opens nothing', async () => {
  const task = await add('Marketing', 'Only task');
  await card([task]);
  const r = await handleTaskShortcut(deps(), 'edit', shortcut({ team: { id: 'T_OTHER' } }));
  expect(r.outcome).toBe('unauthorized');
  expect(client.views.open).not.toHaveBeenCalled();
});

// --- the picker's submission ---

const pick = (taskId: string | null, action: 'edit' | 'waiting') => ({
  team: { id: 'T_RILEY' },
  user: { id: 'U_JOSH' },
  view: {
    private_metadata: JSON.stringify({ action, channelId: CHANNEL, messageTs: TS }),
    state: {
      values: {
        [PICKER_BLOCK]: {
          [PICKER_ACTION]: taskId === null ? {} : { selected_option: { value: taskId } },
        },
      },
    },
  },
});

it('pushes the edit modal for the chosen task', async () => {
  const a = await add('Marketing', 'First task');
  const b = await add('Sales', 'Second task');
  await card([a, b]);

  const r = await handlePickerSubmission(deps(), pick(b.id, 'edit'));
  expect(r.outcome).toBe('opened_edit');
  expect(JSON.parse(String(r.view!.private_metadata)).taskId).toBe(b.id);
});

it('moves only the chosen task to waiting', async () => {
  const a = await add('Marketing', 'First task');
  const b = await add('Sales', 'Second task');
  await card([a, b]);

  const r = await handlePickerSubmission(deps(), pick(b.id, 'waiting'));
  expect(r.outcome).toBe('applied');
  expect((await fetch1(a.id)).status).toBe('open');
  expect((await fetch1(b.id)).status).toBe('waiting');
});

it('refuses a task that was never on that card', async () => {
  const onCard = await add('Marketing', 'On the card');
  const elsewhere = await add('Sales', 'Somewhere else');
  await card([onCard]);

  // The card is the authority on what this message may touch, so a tampered
  // value cannot reach a task that was never rendered on it.
  const r = await handlePickerSubmission(deps(), pick(elsewhere.id, 'waiting'));
  expect(r.outcome).toBe('unknown_card');
  expect((await fetch1(elsewhere.id)).status).toBe('open');
});

it('does nothing when nothing was chosen', async () => {
  const task = await add('Marketing', 'Task');
  await card([task]);
  const r = await handlePickerSubmission(deps(), pick(null, 'waiting'));
  expect(r.outcome).toBe('no_tasks');
  expect((await fetch1(task.id)).status).toBe('open');
});

it('refuses an unauthorized workspace on submit too', async () => {
  const task = await add('Marketing', 'Task');
  await card([task]);
  const body = { ...pick(task.id, 'waiting'), team: { id: 'T_OTHER' } };
  expect((await handlePickerSubmission(deps(), body)).outcome).toBe('unauthorized');
  expect((await fetch1(task.id)).status).toBe('open');
});

it('survives unparseable picker metadata', async () => {
  const body = {
    team: { id: 'T_RILEY' }, user: { id: 'U_JOSH' },
    view: { private_metadata: 'not json', state: { values: {} } },
  };
  expect((await handlePickerSubmission(deps(), body)).outcome).toBe('no_tasks');
});
