import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { capitalizeFirstLetter, createTask, getTask } from '@tr/task-core';
import { saveCard } from '@tr/slack-sync';
import { buildServer } from '../../../api/src/server.js';
import {
  completeTaskOp, reopenTaskOp, moveTaskOp, editTaskOp, createTaskOp,
  postponeToTomorrowOp,
} from './tasks.js';

let db: Db;
let space: any;
let salesId: string;
const slack = { chat: { update: vi.fn() } };
const config = { timeZone: 'America/Chicago', assigneeLabels: { U_JOSH: 'Joshua' } };

const deps = (over: Record<string, unknown> = {}) => ({
  db, actorId: 'U_JOSH', slack: slack as never, config, ...over,
});

beforeEach(async () => {
  db = await createTestDb();
  slack.chat.update = vi.fn().mockResolvedValue({ ok: true });
  const { rows } = await db.query<any>(
    `SELECT id, name, slug, is_inbox FROM spaces WHERE name IN ('Marketing','Sales') ORDER BY name`
  );
  space = rows[0];
  salesId = rows[1].id;
});
afterEach(async () => { await db.close(); });

const seed = (title = 'Call Neil') =>
  createTask(db, { title, spaceId: space.id, assigneeId: 'U_JOSH' });

const withCard = async (task: Awaited<ReturnType<typeof seed>>) => {
  await saveCard(db, {
    channelId: 'C_MKT', messageTs: '1.1', entries: [{ task, space }], version: 1,
  });
  return task;
};

describe('completing and reopening', () => {
  it('writes a completion through to the database', async () => {
    const task = await seed();
    expect(await completeTaskOp(deps(), task.id)).toEqual({ ok: true, taskId: task.id });

    const after = (await getTask(db, task.id))!;
    expect(after.status).toBe('completed');
    expect(after.completed_at).toBeInstanceOf(Date);
  });

  it('is visible through the REST API immediately', async () => {
    const task = await seed();
    await completeTaskOp(deps(), task.id);

    const app = buildServer({ db, apiToken: 't' });
    const res = await app.inject({
      method: 'GET', url: `/tasks/${task.id}`, headers: { authorization: 'Bearer t' },
    });
    expect(res.json().task.status).toBe('completed');
    await app.close();
  });

  it('reopens and clears completed_at', async () => {
    const task = await seed();
    await completeTaskOp(deps(), task.id);
    expect(await reopenTaskOp(deps(), task.id)).toEqual({ ok: true, taskId: task.id });

    const after = (await getTask(db, task.id))!;
    expect(after.status).toBe('open');
    expect(after.completed_at).toBeNull();
  });

  it('records the acting web user in the audit trail', async () => {
    const task = await seed();
    await completeTaskOp(deps({ actorId: 'U_RACHAEL' }), task.id);
    const { rows } = await db.query<{ actor_id: string; source: string }>(
      `SELECT actor_id, source FROM task_events WHERE task_id=$1 AND event='completed'`,
      [task.id]
    );
    expect(rows[0]).toEqual({ actor_id: 'U_RACHAEL', source: 'web' });
  });

  it('is idempotent', async () => {
    const task = await seed();
    const first = await completeTaskOp(deps(), task.id);
    const second = await completeTaskOp(deps(), task.id);
    expect(second).toEqual(first);
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM task_events WHERE task_id=$1 AND event='completed'`,
      [task.id]
    );
    expect(rows[0]!.n).toBe(1);
  });
});

describe('editing', () => {
  it('changes and clears a priority from the edit pane', async () => {
    const task = await seed();
    expect((await editTaskOp(deps(), task.id, { priority: 'P1' })).ok).toBe(true);
    expect((await getTask(db, task.id))!.priority).toBe('P1');
    expect((await editTaskOp(deps(), task.id, { priority: null })).ok).toBe(true);
    expect((await getTask(db, task.id))!.priority).toBeNull();
  });

  it('reports an invalid priority on edit without changing the task', async () => {
    const task = await seed();
    await editTaskOp(deps(), task.id, { priority: 'P2' });
    const r = await editTaskOp(deps(), task.id, { priority: 'P9' as never });
    expect(r).toEqual({ ok: false, error: 'That priority is not one of P0-P3.' });
    expect((await getTask(db, task.id))!.priority).toBe('P2');
  });

  // Narrowed 2026-09-11: the opening letter is capitalised at both write paths.
  // Everything after it is still written exactly as typed.
  it('writes a title byte-exact apart from the opening letter', async () => {
    const task = await seed();
    for (const title of [
      'Offer Neil Instagram and Facebook package for $100',
      'Waiting on Milltown’s reply to the email proposal',
      'Secure Logic — three-month honeymoon check-in with Marty',
      'ship it 🚀',
      'fix *urgent* bug_now~ish~',
    ]) {
      expect((await editTaskOp(deps(), task.id, { title })).ok).toBe(true);
      const stored = (await getTask(db, task.id))!.title;
      expect(stored.slice(1)).toBe(title.slice(1));
      expect(stored).toBe(capitalizeFirstLetter(title));
    }
  });

  it('leaves the title alone when the patch does not mention it', async () => {
    const task = await seed('Exact original title');
    await editTaskOp(deps(), task.id, { status: 'waiting', waitingOn: 'Neil' });
    expect((await getTask(db, task.id))!.title).toBe('Exact original title');
  });

  it('rejects an empty title with a message rather than throwing', async () => {
    const task = await seed('Exact original title');
    const result = await editTaskOp(deps(), task.id, { title: '   ' });
    expect(result).toEqual({ ok: false, error: 'A task needs a title.' });
    expect((await getTask(db, task.id))!.title).toBe('Exact original title');
  });

  it('records an edited event attributed to the web user', async () => {
    const task = await seed();
    await editTaskOp(deps(), task.id, { title: 'Renamed on the web' });
    const { rows } = await db.query<{ actor_id: string; source: string }>(
      `SELECT actor_id, source FROM task_events WHERE task_id=$1 AND event='edited'`,
      [task.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ actor_id: 'U_JOSH', source: 'web' });
  });

  it('changes every other field', async () => {
    const task = await seed();
    const due = new Date('2026-09-15T05:00:00Z');
    await editTaskOp(deps(), task.id, {
      spaceId: salesId, status: 'waiting', waitingOn: 'Neil to reply',
      assigneeId: 'U_RACHAEL', dueAt: due, details: 'notes',
    });
    const after = (await getTask(db, task.id))!;
    expect(after.space_id).toBe(salesId);
    expect(after.status).toBe('waiting');
    expect(after.waiting_on).toBe('Neil to reply');
    expect(after.assignee_id).toBe('U_RACHAEL');
    expect(after.due_at?.getTime()).toBe(due.getTime());
    expect(after.details).toBe('notes');
  });

  it('rejects a malformed id with a message, not a database error', async () => {
    expect(await editTaskOp(deps(), 'not-a-uuid', { title: 'x' }))
      .toEqual({ ok: false, error: 'That task could not be found.' });
  });

  it('rejects an unknown but well-formed id', async () => {
    const result = await completeTaskOp(deps(), '00000000-0000-4000-8000-000000000000');
    expect(result.ok).toBe(false);
  });
});

describe('Tomorrow, from the Today card', () => {
  const now = new Date('2026-10-13T20:31:00Z'); // 3:31pm CDT, Oct 13

  it('moves the due date to tomorrow at the same Chicago time of day', async () => {
    const task = await createTask(db, {
      title: 'Call Neil at 2', spaceId: space.id, dueAt: new Date('2026-10-13T19:00:00Z'),
    });
    expect(await postponeToTomorrowOp(deps(), task.id, now))
      .toEqual({ ok: true, taskId: task.id });
    expect((await getTask(db, task.id))!.due_at!.toISOString())
      .toBe('2026-10-14T19:00:00.000Z'); // 2pm CDT, Oct 14
  });

  it('sends overdue work to tomorrow, not to the day after it was due', async () => {
    const task = await createTask(db, {
      title: 'Overdue', spaceId: space.id, dueAt: new Date('2026-10-09T14:00:00Z'),
    });
    await postponeToTomorrowOp(deps(), task.id, now);
    expect((await getTask(db, task.id))!.due_at!.toISOString())
      .toBe('2026-10-14T14:00:00.000Z');
  });

  it('changes the due date and nothing else', async () => {
    const task = await createTask(db, {
      title: 'Keep me exactly', spaceId: space.id, assigneeId: 'U_JOSH', priority: 'P1',
      dueAt: new Date('2026-10-13T19:00:00Z'), details: 'notes',
    });
    await postponeToTomorrowOp(deps(), task.id, now);
    const after = (await getTask(db, task.id))!;
    expect({ ...after, due_at: null }).toEqual({ ...task, due_at: null });
  });

  it('is logged as an ordinary due-date edit by the web user', async () => {
    const task = await createTask(db, {
      title: 'Audit me', spaceId: space.id, dueAt: new Date('2026-10-13T19:00:00Z'),
    });
    await postponeToTomorrowOp(deps(), task.id, now);
    const { rows } = await db.query<{ actor_id: string; source: string; detail: unknown }>(
      `SELECT actor_id, source, detail FROM task_events
        WHERE task_id = $1 AND event = 'edited'`, [task.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: 'U_JOSH', source: 'web' });
    expect(JSON.stringify(rows[0]!.detail)).toContain('due_at');
  });

  it('redraws any Slack card showing the task', async () => {
    const task = await withCard(await createTask(db, {
      title: 'On a card', spaceId: space.id, dueAt: new Date('2026-10-13T19:00:00Z'),
    }));
    await postponeToTomorrowOp(deps(), task.id, now);
    expect(slack.chat.update).toHaveBeenCalled();
  });

  it('reports an unknown task rather than throwing', async () => {
    expect(await postponeToTomorrowOp(deps(), '00000000-0000-4000-8000-000000000000', now))
      .toEqual({ ok: false, error: 'That task could not be found.' });
  });
});

describe('moving', () => {
  it('changes space and status', async () => {
    const task = await seed();
    await moveTaskOp(deps(), task.id, { spaceId: salesId, status: 'waiting' });
    const after = (await getTask(db, task.id))!;
    expect(after.space_id).toBe(salesId);
    expect(after.status).toBe('waiting');
  });

  it('cannot touch the title', async () => {
    const task = await seed('Exact original title');
    await moveTaskOp(deps(), task.id, {
      status: 'waiting', title: 'AI-REWRITTEN',
    } as never);
    expect((await getTask(db, task.id))!.title).toBe('Exact original title');
  });
});

describe('creating', () => {
  it('stores the title byte-exact and resolves the Space from its slug', async () => {
    const title = 'Consolidate 401(k): move Corebridge to Fidelity';
    const result = await createTaskOp(deps(), { title, spaceSlug: 'sales' });
    expect(result.ok).toBe(true);

    const task = (await getTask(db, (result as { taskId: string }).taskId))!;
    expect(task.title).toBe(title);
    expect(task.space_id).toBe(salesId);
    expect(task.source_platform).toBe('web');
    expect(task.created_by).toBe('U_JOSH');
  });

  it('trims only outer whitespace', async () => {
    const result = await createTaskOp(deps(), {
      title: '   Call Neil   ', spaceSlug: 'marketing',
    });
    const task = (await getTask(db, (result as { taskId: string }).taskId))!;
    expect(task.title).toBe('Call Neil');
  });

  it('rejects an empty title and writes nothing', async () => {
    expect(await createTaskOp(deps(), { title: '  ', spaceSlug: 'marketing' }))
      .toEqual({ ok: false, error: 'A task needs a title.' });
    const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks`);
    expect(rows[0]!.n).toBe(0);
  });

  it('rejects an unknown Space and writes nothing', async () => {
    const result = await createTaskOp(deps(), {
      title: 'X', spaceSlug: 'no-such-space',
    });
    expect(result.ok).toBe(false);
    const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks`);
    expect(rows[0]!.n).toBe(0);
  });

  it('accepts a Space by canonical name or alias, not just slug', async () => {
    expect((await createTaskOp(deps(), {
      title: 'A', spaceSlug: 'Client - Nazareth Law',
    })).ok).toBe(true);
    expect((await createTaskOp(deps(), {
      title: 'B', spaceSlug: 'Personal tasks',
    })).ok).toBe(true);
  });

  // --- parity with the Edit pane, 2026-09-11 ---

  it('defaults to open with no waiting-on and no details', async () => {
    const r = await createTaskOp(deps(), { title: 'Plain', spaceSlug: 'sales' });
    const task = (await getTask(db, (r as { taskId: string }).taskId))!;
    expect(task.status).toBe('open');
    expect(task.waiting_on).toBeNull();
    expect(task.details).toBeNull();
  });

  it('captures a waiting task with what it is waiting on, in one step', async () => {
    const r = await createTaskOp(deps(), {
      title: 'Chase the proposal', spaceSlug: 'sales',
      status: 'waiting', waitingOn: 'Milltown’s reply',
    });
    expect(r.ok).toBe(true);
    const task = (await getTask(db, (r as { taskId: string }).taskId))!;
    expect(task.status).toBe('waiting');
    expect(task.waiting_on).toBe('Milltown’s reply');
  });

  it('captures details verbatim', async () => {
    const details = 'Line one\nLine two — with an em dash and *markdown*';
    const r = await createTaskOp(deps(), {
      title: 'With notes', spaceSlug: 'sales', details,
    });
    const task = (await getTask(db, (r as { taskId: string }).taskId))!;
    expect(task.details).toBe(details);
  });

  it('records the status change as its own audited event, like Slack capture', async () => {
    const r = await createTaskOp(deps(), {
      title: 'Blocked thing', spaceSlug: 'sales', status: 'waiting',
    });
    const { rows } = await db.query<{ event: string }>(
      `SELECT event FROM task_events WHERE task_id = $1 ORDER BY created_at, id`,
      [(r as { taskId: string }).taskId]
    );
    expect(rows.map((e) => e.event)).toEqual(['created', 'moved']);
  });

  /**
   * `completed` is not a capture status on either surface. Without this guard a
   * hand-built POST could create an already-completed task, which the Slack
   * modal has never allowed.
   */
  it('refuses to create a task that is already completed', async () => {
    const r = await createTaskOp(deps(), {
      title: 'Already done', spaceSlug: 'sales',
      status: 'completed' as never,
    });
    expect(r).toEqual({ ok: false, error: 'A task cannot be created as "completed".' });
    const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks`);
    expect(rows[0]!.n).toBe(0);
  });

  // --- priority, 2026-09-11 ---

  it('captures a priority chosen in the pane', async () => {
    const r = await createTaskOp(deps(), {
      title: 'Fix Stripe checkout', spaceSlug: 'sales', priority: 'P0',
    });
    const task = (await getTask(db, (r as { taskId: string }).taskId))!;
    expect(task.priority).toBe('P0');
  });

  it('captures no priority when the "No priority" option is chosen', async () => {
    // The form sends '' for that option; the action maps it to null.
    const r = await createTaskOp(deps(), {
      title: 'Unprioritized', spaceSlug: 'sales', priority: null,
    });
    const task = (await getTask(db, (r as { taskId: string }).taskId))!;
    expect(task.priority).toBeNull();
  });

  it('reports an invalid priority as a sentence rather than crashing', async () => {
    const r = await createTaskOp(deps(), {
      title: 'Bad', spaceSlug: 'sales', priority: 'P7' as never,
    });
    expect(r).toEqual({ ok: false, error: 'That priority is not one of P0-P3.' });
    const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks`);
    expect(rows[0]!.n).toBe(0);
  });

  it('ignores an empty waiting-on and empty details rather than storing blanks', async () => {
    const r = await createTaskOp(deps(), {
      title: 'Blank fields', spaceSlug: 'sales', waitingOn: '   ', details: '',
    });
    const task = (await getTask(db, (r as { taskId: string }).taskId))!;
    expect(task.status).toBe('open');
    expect(task.waiting_on).toBeNull();
    expect(task.details).toBeNull();
  });
});

describe('Slack card sync', () => {
  it('redraws the card after a completion', async () => {
    const task = await withCard(await seed());
    await completeTaskOp(deps(), task.id);

    expect(slack.chat.update).toHaveBeenCalledTimes(1);
    const el = (slack.chat.update.mock.calls[0]![0] as any).blocks
      .find((b: any) => b.type === 'actions').elements[0];
    expect(el.options[0].text.text).toBe('~Call Neil~');
  });

  it('redraws after an edit, a move, and a reopen too', async () => {
    const task = await withCard(await seed());
    await editTaskOp(deps(), task.id, { title: 'Renamed' });
    await moveTaskOp(deps(), task.id, { status: 'waiting' });
    await completeTaskOp(deps(), task.id);
    await reopenTaskOp(deps(), task.id);
    expect(slack.chat.update).toHaveBeenCalledTimes(4);
  });

  it('does not redraw when no Slack client is configured', async () => {
    const task = await withCard(await seed());
    const result = await completeTaskOp(
      { db, actorId: 'U_JOSH' }, task.id
    );
    expect(result.ok).toBe(true);
    expect(slack.chat.update).not.toHaveBeenCalled();
    expect((await getTask(db, task.id))!.status).toBe('completed');
  });

  it('answers without waiting for Slack when given a way to defer the redraw', async () => {
    const task = await withCard(await seed());
    // Slack that never answers: awaiting it would hang this test.
    slack.chat.update = vi.fn().mockReturnValue(new Promise(() => {}));
    const deferred: Array<() => Promise<void>> = [];

    const result = await completeTaskOp(deps({ defer: (w: () => Promise<void>) => deferred.push(w) }), task.id);

    expect(result).toEqual({ ok: true, taskId: task.id });
    expect((await getTask(db, task.id))!.status).toBe('completed');
    // Nothing has been sent to Slack yet; the work is queued for later.
    expect(slack.chat.update).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);
  });

  it('still redraws the card when the deferred work runs, and swallows a failure', async () => {
    const task = await withCard(await seed());
    const deferred: Array<() => Promise<void>> = [];
    await completeTaskOp(deps({ defer: (w: () => Promise<void>) => deferred.push(w) }), task.id);
    await deferred[0]!();
    expect(slack.chat.update).toHaveBeenCalledTimes(1);

    slack.chat.update = vi.fn().mockRejectedValue(new Error('slack is down'));
    await reopenTaskOp(deps({ defer: (w: () => Promise<void>) => deferred.push(w) }), task.id);
    await expect(deferred[1]!()).resolves.toBeUndefined();
  });

  // The important one: Slack must never be able to lose the user's edit.
  it('keeps the task change when the Slack redraw fails', async () => {
    const task = await withCard(await seed());
    slack.chat.update = vi.fn().mockRejectedValue(new Error('slack is down'));

    const result = await completeTaskOp(deps(), task.id);
    expect(result).toEqual({ ok: true, taskId: task.id });
    expect((await getTask(db, task.id))!.status).toBe('completed');
  });

  it('keeps an edited title when the Slack redraw fails', async () => {
    const task = await withCard(await seed());
    slack.chat.update = vi.fn().mockRejectedValue(new Error('slack is down'));

    expect((await editTaskOp(deps(), task.id, { title: 'Kept anyway' })).ok).toBe(true);
    expect((await getTask(db, task.id))!.title).toBe('Kept anyway');
  });
});
