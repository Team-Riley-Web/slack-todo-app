import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask, getTask } from '@tr/task-core';
import { EDIT_BLOCKS } from '@tr/slack-ui';
import { saveCard } from '../cards.js';
import { handleEditOpen, handleEditSubmission } from './edit-modal.js';
import { handleWaitingAction } from './waiting.js';

let db: Db;
let spaceId: string;
let otherSpaceId: string;
let space: any;
const config = {
  teamId: 'T_RILEY', authorizedUserIds: [], defaultAssigneeId: 'U_JOSH',
  assigneeLabels: { U_JOSH: 'Joshua' }, timeZone: 'America/Chicago', mode: 'socket' as const,
};

const client = {
  views: { open: vi.fn() },
  chat: { update: vi.fn() },
};

beforeEach(async () => {
  db = await createTestDb();
  client.views.open = vi.fn().mockResolvedValue({ ok: true });
  client.chat.update = vi.fn().mockResolvedValue({ ok: true });
  const { rows } = await db.query<any>(
    `SELECT id, name, slug, is_inbox FROM spaces WHERE name IN ('Marketing','Sales') ORDER BY name`
  );
  space = rows[0]; spaceId = rows[0].id; otherSpaceId = rows[1].id;
});
afterEach(async () => { await db.close(); });

const deps = () => ({ db, client: client as never, config });

const seed = async (title = 'Call Neil') => {
  const task = await createTask(db, { title, spaceId, assigneeId: 'U_JOSH' });
  await saveCard(db, {
    channelId: 'C_MKT', messageTs: '1700000000.000100',
    entries: [{ task, space }], version: 1,
  });
  return task;
};

const openBody = (value: string, over: Record<string, unknown> = {}) => ({
  type: 'block_actions',
  team: { id: 'T_RILEY' }, user: { id: 'U_JOSH' },
  trigger_id: 'trig-123',
  container: { type: 'message', channel_id: 'C_MKT', message_ts: '1700000000.000100' },
  actions: [{
    type: 'overflow', action_id: 'task_waiting', block_id: 'task_controls:0',
    action_ts: '9.1', selected_option: { value },
  }],
  ...over,
});

const submitBody = (
  taskId: string, values: Record<string, any>, over: Record<string, unknown> = {}
) => ({
  type: 'view_submission',
  team: { id: 'T_RILEY' }, user: { id: 'U_JOSH' },
  view: {
    callback_id: 'task_edit_modal',
    private_metadata: JSON.stringify({
      taskId, channelId: 'C_MKT', messageTs: '1700000000.000100',
    }),
    state: { values },
  },
  ...over,
});

const fullValues = (over: Record<string, any> = {}) => ({
  [EDIT_BLOCKS.title]: { title: { value: 'Call Neil' } },
  [EDIT_BLOCKS.space]: { space: { selected_option: { value: spaceId } } },
  [EDIT_BLOCKS.status]: { status: { selected_option: { value: 'open' } } },
  [EDIT_BLOCKS.assignee]: { assignee: { selected_user: 'U_JOSH' } },
  [EDIT_BLOCKS.due]: { due: { selected_date_time: null } },
  [EDIT_BLOCKS.waitingOn]: { waiting_on: { value: null } },
  [EDIT_BLOCKS.details]: { details: { value: null } },
  ...over,
});

describe('opening the modal', () => {
  it('opens with the payload trigger_id', async () => {
    const task = await seed();
    const r = await handleEditOpen(deps(), openBody(`edit:${task.id}`) as never);
    expect(r.outcome).toBe('opened');
    expect(client.views.open).toHaveBeenCalledTimes(1);
    expect(client.views.open.mock.calls[0]![0].trigger_id).toBe('trig-123');
  });

  it('opens before doing any card work, since trigger_id expires in 3 seconds', async () => {
    const task = await seed();
    await handleEditOpen(deps(), openBody(`edit:${task.id}`) as never);
    expect(client.views.open).toHaveBeenCalled();
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it('prefills the view from the task', async () => {
    const task = await seed('Secure Logic — check-in with Marty');
    await handleEditOpen(deps(), openBody(`edit:${task.id}`) as never);
    const view = client.views.open.mock.calls[0]![0].view as any;
    const titleBlock = view.blocks.find((b: any) => b.block_id === EDIT_BLOCKS.title);
    expect(titleBlock.element.initial_value).toBe('Secure Logic — check-in with Marty');
  });

  it('rejects an unauthorized user with no modal at all', async () => {
    const task = await seed();
    const r = await handleEditOpen(
      deps(), openBody(`edit:${task.id}`, { team: { id: 'T_OTHER' } }) as never
    );
    expect(r.outcome).toBe('unauthorized');
    expect(client.views.open).not.toHaveBeenCalled();
  });

  it('ignores the waiting overflow values', async () => {
    const task = await seed();
    for (const value of [`waiting:${task.id}`, `open:${task.id}`, '']) {
      const r = await handleEditOpen(deps(), openBody(value) as never);
      expect(r.outcome).toBe('no_task');
    }
    expect(client.views.open).not.toHaveBeenCalled();
  });

  it('reports not_found for an unknown or malformed id without opening', async () => {
    await seed();
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const r = await handleEditOpen(deps(), openBody(`edit:${id}`) as never);
      expect(r.outcome).toBe('not_found');
    }
    expect(client.views.open).not.toHaveBeenCalled();
  });
});

describe('the waiting handler ignores edit values', () => {
  it('does not act on an edit: option', async () => {
    const task = await seed();
    const r = await handleWaitingAction(
      { db, client: { chat: client.chat } as never, config },
      openBody(`edit:${task.id}`) as never
    );
    expect(r.outcome).toBe('noop');
    expect((await getTask(db, task.id))!.status).toBe('open');
  });
});

describe('submitting the modal', () => {
  it('writes a new title byte-exact and redraws the card in place', async () => {
    const task = await seed();
    const title = 'Offer Neil Instagram and Facebook package for $100';
    const r = await handleEditSubmission(
      deps(),
      submitBody(task.id, fullValues({ [EDIT_BLOCKS.title]: { title: { value: title } } })) as never
    );
    expect(r.outcome).toBe('saved');
    expect((await getTask(db, task.id))!.title).toBe(title);

    expect(client.chat.update).toHaveBeenCalledTimes(1);
    const arg = client.chat.update.mock.calls[0]![0] as any;
    expect(arg.ts).toBe('1700000000.000100');
    expect(JSON.stringify(arg.blocks)).toContain(title);
  });

  it('returns unchanged and writes no event when nothing moved', async () => {
    const task = await seed();
    const r = await handleEditSubmission(deps(), submitBody(task.id, fullValues()) as never);
    expect(r.outcome).toBe('unchanged');
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM task_events WHERE task_id=$1 AND event='edited'`,
      [task.id]
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('changes every other field', async () => {
    const task = await seed();
    const due = 1_789_000_000;
    await handleEditSubmission(deps(), submitBody(task.id, fullValues({
      [EDIT_BLOCKS.space]: { space: { selected_option: { value: otherSpaceId } } },
      [EDIT_BLOCKS.status]: { status: { selected_option: { value: 'waiting' } } },
      [EDIT_BLOCKS.assignee]: { assignee: { selected_user: 'U_RACHAEL' } },
      [EDIT_BLOCKS.due]: { due: { selected_date_time: due } },
      [EDIT_BLOCKS.waitingOn]: { waiting_on: { value: 'Neil to reply' } },
      [EDIT_BLOCKS.details]: { details: { value: 'line one\nline two' } },
    })) as never);

    const after = (await getTask(db, task.id))!;
    expect(after.space_id).toBe(otherSpaceId);
    expect(after.status).toBe('waiting');
    expect(after.assignee_id).toBe('U_RACHAEL');
    expect(after.due_at?.getTime()).toBe(due * 1000);
    expect(after.waiting_on).toBe('Neil to reply');
    expect(after.details).toBe('line one\nline two');
  });

  it('completing through the modal renders the card checked and struck through', async () => {
    const task = await seed();
    await handleEditSubmission(deps(), submitBody(task.id, fullValues({
      [EDIT_BLOCKS.status]: { status: { selected_option: { value: 'completed' } } },
    })) as never);

    expect((await getTask(db, task.id))!.status).toBe('completed');
    const el = (client.chat.update.mock.calls[0]![0] as any).blocks
      .find((b: any) => b.type === 'actions').elements[0];
    expect(el.options[0].text.text).toBe('~Call Neil~');
    expect(el.initial_options).toHaveLength(1);
  });

  it('clears assignee, due, and details when the inputs come back empty', async () => {
    const task = await createTask(db, {
      title: 'X', spaceId, assigneeId: 'U_JOSH',
      dueAt: new Date('2026-09-15T05:00:00Z'), details: 'notes',
    });
    await saveCard(db, {
      channelId: 'C_MKT', messageTs: '1700000000.000100',
      entries: [{ task, space }], version: 1,
    });
    await handleEditSubmission(deps(), submitBody(task.id, fullValues({
      [EDIT_BLOCKS.title]: { title: { value: 'X' } },
      [EDIT_BLOCKS.assignee]: { assignee: { selected_user: null } },
      [EDIT_BLOCKS.due]: { due: { selected_date_time: null } },
      [EDIT_BLOCKS.details]: { details: { value: '' } },
    })) as never);

    const after = (await getTask(db, task.id))!;
    expect(after.assignee_id).toBeNull();
    expect(after.due_at).toBeNull();
    expect(after.details).toBeNull();
  });

  it('returns a field error for a blank title and writes nothing', async () => {
    const task = await seed();
    const r = await handleEditSubmission(deps(), submitBody(task.id, fullValues({
      [EDIT_BLOCKS.title]: { title: { value: '   ' } },
    })) as never);
    expect(r.outcome).toBe('invalid');
    expect(r.error?.blockId).toBe(EDIT_BLOCKS.title);
    expect((await getTask(db, task.id))!.title).toBe('Call Neil');
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it('rejects an unauthorized submission with no write', async () => {
    const task = await seed();
    const r = await handleEditSubmission(
      deps(),
      submitBody(task.id, fullValues({
        [EDIT_BLOCKS.title]: { title: { value: 'hacked' } },
      }), { team: { id: 'T_OTHER' } }) as never
    );
    expect(r.outcome).toBe('unauthorized');
    expect((await getTask(db, task.id))!.title).toBe('Call Neil');
  });

  it('reports not_found for a task that no longer exists', async () => {
    const r = await handleEditSubmission(
      deps(),
      submitBody('00000000-0000-4000-8000-000000000000', fullValues()) as never
    );
    expect(r.outcome).toBe('not_found');
  });

  it('saves even when the originating message is not a recorded card', async () => {
    const task = await createTask(db, { title: 'No card', spaceId });
    const r = await handleEditSubmission(deps(), submitBody(task.id, fullValues({
      [EDIT_BLOCKS.title]: { title: { value: 'Renamed anyway' } },
    })) as never);
    expect(r.outcome).toBe('saved');
    expect((await getTask(db, task.id))!.title).toBe('Renamed anyway');
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it('records one edited audit event attributed to the acting user', async () => {
    const task = await seed();
    await handleEditSubmission(deps(), submitBody(task.id, fullValues({
      [EDIT_BLOCKS.title]: { title: { value: 'Renamed' } },
    })) as never);
    const { rows } = await db.query<{ actor_id: string; source: string }>(
      `SELECT actor_id, source FROM task_events WHERE task_id=$1 AND event='edited'`,
      [task.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ actor_id: 'U_JOSH', source: 'slack' });
  });
});
