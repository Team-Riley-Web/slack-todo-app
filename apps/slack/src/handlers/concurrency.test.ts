import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask, getTask, completeTask } from '@tr/task-core';
import { saveCard, claimInteraction } from '@tr/slack-sync';
import { handleCheckboxToggle } from './checkbox.js';

/**
 * SCOPE, stated honestly: PGlite runs a single connection and serializes
 * statements, so these exercise races in THIS codebase's logic — concurrent
 * promises, interleaved read-modify-write, out-of-order redraws. They do NOT
 * exercise Postgres MVCC contention (two connections, row locks, serialization
 * failures). That needs a real multi-connection server; see the QA report.
 */

let db: Db;
let spaceId: string;
let space: any;
const config = {
  teamId: 'T_RILEY', authorizedUserIds: [], defaultAssigneeId: 'U_JOSH',
  assigneeLabels: { U_JOSH: 'Joshua' }, timeZone: 'America/Chicago', mode: 'socket' as const,
};

beforeEach(async () => {
  db = await createTestDb();
  const { rows } = await db.query<any>(
    `SELECT id, name, slug, is_inbox FROM spaces WHERE name = 'Client - Nazareth Law'`
  );
  space = rows[0]; spaceId = rows[0].id;
});
afterEach(async () => { await db.close(); });

/**
 * `version` is the render the simulated client was looking at. Slack echoes back
 * the block_id we rendered, so a client that has not refreshed sends the older
 * version — which is exactly the stale-payload case.
 */
const payload = (
  selectedIds: string[], actionTs: string, user = 'U_JOSH', version: number | null = 1
) => {
  const blockId = version === null ? 'task_toggle:0' : `task_toggle:0:v${version}`;
  return {
    type: 'block_actions',
    team: { id: 'T_RILEY' }, user: { id: user },
    container: { type: 'message', channel_id: 'C_NL', message_ts: '1700000000.000100' },
    actions: [{
      type: 'checkboxes', action_id: 'task_checkbox', block_id: blockId,
      action_ts: actionTs,
      selected_options: selectedIds.map((id) => ({ value: id })),
    }],
    state: {
      values: {
        [blockId]: {
          task_checkbox: {
            type: 'checkboxes',
            selected_options: selectedIds.map((id) => ({ value: id })),
          },
        },
      },
    },
  };
};


describe('concurrent toggles on one card', () => {
  const seed = async (title = 'Call Neil') => {
    const task = await createTask(db, { title, spaceId, assigneeId: 'U_JOSH' });
    await saveCard(db, {
      channelId: 'C_NL', messageTs: '1700000000.000100', entries: [{ task, space }],
    });
    return task;
  };

  it('applies exactly one transition when the same click arrives five times at once', async () => {
    const task = await seed();
    const client = { chat: { update: vi.fn().mockResolvedValue({ ok: true }) } };
    const deps = { db, client: client as never, config };

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        handleCheckboxToggle(deps, payload([task.id], '9.1') as never))
    );

    expect(results.filter((r) => r.outcome === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'duplicate')).toHaveLength(4);

    const { rows } = await db.query(
      `SELECT 1 FROM task_events WHERE task_id = $1 AND event = 'completed'`, [task.id]
    );
    expect(rows).toHaveLength(1);
    expect((await getTask(db, task.id))!.status).toBe('completed');
  });

  it('leaves the final rendered message matching the database, however slow the updates', async () => {
    const task = await seed();
    let call = 0;
    const rendered: string[] = [];
    const client = {
      chat: {
        // First update is slow: without the lock it could land last and
        // overwrite the newer render with stale state.
        update: vi.fn(async (args: any) => {
          const n = call += 1;
          const el = args.blocks.find((b: any) => b.type === 'actions').elements[0];
          const checked = Array.isArray(el.initial_options) && el.initial_options.length > 0;
          if (n === 1) await new Promise((r) => setTimeout(r, 40));
          rendered.push(checked ? 'checked' : 'unchecked');
          return { ok: true };
        }),
      },
    };
    const deps = { db, client: client as never, config };

    // check, then uncheck, fired together
    await Promise.all([
      handleCheckboxToggle(deps, payload([task.id], '9.1') as never),
      handleCheckboxToggle(deps, payload([], '9.2') as never),
    ]);

    const final = (await getTask(db, task.id))!;
    expect(rendered.at(-1)).toBe(final.status === 'completed' ? 'checked' : 'unchecked');
  });

  it('applies both toggles when two users check different tasks at the same moment', async () => {
    const a = await createTask(db, { title: 'Meditate', spaceId });
    const b = await createTask(db, { title: 'Exercise', spaceId });
    await saveCard(db, {
      channelId: 'C_NL', messageTs: '1700000000.000100',
      entries: [{ task: a, space }, { task: b, space }],
    });
    const client = { chat: { update: vi.fn().mockResolvedValue({ ok: true }) } };
    const deps = { db, client: client as never, config };

    await Promise.all([
      handleCheckboxToggle(deps, payload([a.id], '9.1', 'U_JOSH') as never),
      handleCheckboxToggle(deps, payload([b.id], '9.2', 'U_RACHAEL') as never),
    ]);

    // Neither user's change is lost, even though each payload omitted the other's task.
    expect((await getTask(db, a.id))!.status).toBe('completed');
    expect((await getTask(db, b.id))!.status).toBe('completed');
  });

  it('does not lose a completion when a stale client toggles a sibling', async () => {
    const a = await createTask(db, { title: 'Meditate', spaceId });
    const b = await createTask(db, { title: 'Exercise', spaceId });
    await completeTask(db, b.id, { id: 'U_JOSH', source: 'test' });
    await saveCard(db, {
      channelId: 'C_NL', messageTs: '1700000000.000100',
      entries: [{ task: a, space }, { task: (await getTask(db, b.id))!, space }],
    });
    const client = { chat: { update: vi.fn().mockResolvedValue({ ok: true }) } };
    const deps = { db, client: client as never, config };

    // Payload includes b as selected (correct) plus a newly checked.
    await handleCheckboxToggle(deps, payload([a.id, b.id], '9.3') as never);
    expect((await getTask(db, a.id))!.status).toBe('completed');
    expect((await getTask(db, b.id))!.status).toBe('completed');
  });
});

describe('concurrent claims and completions', () => {
  it('lets exactly one of many simultaneous claims through', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimInteraction(db, 'C', '1.1', '9.1'))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('records one completed event for ten simultaneous completeTask calls', async () => {
    const t = await createTask(db, { title: 'X', spaceId });
    const actor = { id: 'U_JOSH', source: 'test' };
    const done = await Promise.all(
      Array.from({ length: 10 }, () => completeTask(db, t.id, actor))
    );
    const stamps = new Set(done.map((d) => d.completed_at!.getTime()));
    expect(stamps.size).toBe(1); // every caller sees the same completion time
    const { rows } = await db.query(
      `SELECT 1 FROM task_events WHERE task_id = $1 AND event = 'completed'`, [t.id]
    );
    expect(rows).toHaveLength(1);
  });
});

describe('stale payloads', () => {
  const seedTwo = async () => {
    const a = await createTask(db, { title: 'Meditate', spaceId });
    const b = await createTask(db, { title: 'Exercise', spaceId });
    await saveCard(db, {
      channelId: 'C_NL', messageTs: '1700000000.000100',
      entries: [{ task: a, space }, { task: b, space }], version: 1,
    });
    return { a, b };
  };

  // Regression: ISSUE-009 — a second user's stale selection was diffed against
  // the newest render, so it read as a deliberate uncheck and silently reopened
  // the first user's completed task.
  // Found by /qa on 2026-09-09
  // Report: .gstack/qa-reports/qa-report-team-riley-tasks-2026-09-09.md
  it('does not revert another user completion when a stale client clicks', async () => {
    const { a, b } = await seedTwo();
    const client = { chat: { update: vi.fn().mockResolvedValue({ ok: true }) } };
    const deps = { db, client: client as never, config };

    // User 1 checks a. The card advances to v2.
    await handleCheckboxToggle(deps, payload([a.id], '9.1', 'U_JOSH', 1) as never);
    expect((await getTask(db, a.id))!.status).toBe('completed');

    // User 2 is still looking at v1 and checks b. Their payload omits a.
    await handleCheckboxToggle(deps, payload([b.id], '9.2', 'U_RACHAEL', 1) as never);

    expect((await getTask(db, b.id))!.status).toBe('completed'); // their click landed
    expect((await getTask(db, a.id))!.status).toBe('completed'); // and a survived
  });

  it('still honours a genuine uncheck from a current client', async () => {
    const { a } = await seedTwo();
    const client = { chat: { update: vi.fn().mockResolvedValue({ ok: true }) } };
    const deps = { db, client: client as never, config };

    await handleCheckboxToggle(deps, payload([a.id], '9.1', 'U_JOSH', 1) as never);
    expect((await getTask(db, a.id))!.status).toBe('completed');

    // Client refreshed to v2, then unchecks: a real reopen, and it must apply.
    await handleCheckboxToggle(deps, payload([], '9.2', 'U_JOSH', 2) as never);
    expect((await getTask(db, a.id))!.status).toBe('open');
  });

  it('advances the render version on every redraw', async () => {
    const { a } = await seedTwo();
    const client = { chat: { update: vi.fn().mockResolvedValue({ ok: true }) } };
    const deps = { db, client: client as never, config };
    await handleCheckboxToggle(deps, payload([a.id], '9.1', 'U_JOSH', 1) as never);
    const { rows } = await db.query<{ version: number }>(
      `SELECT version FROM slack_cards WHERE message_ts = '1700000000.000100'`
    );
    expect(Number(rows[0]!.version)).toBe(2);
  });

  it('falls back to the latest render for a payload with no version', async () => {
    const { a } = await seedTwo();
    const client = { chat: { update: vi.fn().mockResolvedValue({ ok: true }) } };
    const deps = { db, client: client as never, config };
    // A card posted before versioning existed still has to work.
    const r = await handleCheckboxToggle(deps, payload([a.id], '9.1', 'U_JOSH', null) as never);
    expect(r.outcome).toBe('applied');
    expect((await getTask(db, a.id))!.status).toBe('completed');
  });

  it('retains a bounded window of render versions', async () => {
    const { a } = await seedTwo();
    const client = { chat: { update: vi.fn().mockResolvedValue({ ok: true }) } };
    const deps = { db, client: client as never, config };
    for (let i = 0; i < 10; i += 1) {
      await handleCheckboxToggle(deps, payload([a.id], `9.${i}`, 'U_JOSH', i + 1) as never);
    }
    const { rows } = await db.query<{ rendered_versions: unknown }>(
      `SELECT rendered_versions FROM slack_cards WHERE message_ts = '1700000000.000100'`
    );
    const raw = rows[0]!.rendered_versions;
    const versions = typeof raw === 'string' ? JSON.parse(raw) : raw;
    expect(Object.keys(versions as object).length).toBeLessThanOrEqual(5);
  });
});
