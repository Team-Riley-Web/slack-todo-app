import { it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask } from '@tr/task-core';
import { buildServer } from './server.js';

let db: Db;
let app: ReturnType<typeof buildServer>;
let spaceId: string;

beforeEach(async () => {
  db = await createTestDb();
  app = buildServer({ db, apiToken: 'secret-token' });
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM spaces WHERE name = 'Client - Nazareth Law'`
  );
  spaceId = rows[0]!.id;
});
afterEach(async () => { await app.close(); await db.close(); });

const auth = { authorization: 'Bearer secret-token' };

it('rejects an unauthenticated request', async () => {
  expect((await app.inject({ method: 'GET', url: '/tasks' })).statusCode).toBe(401);
});

it('rejects a wrong bearer token', async () => {
  const r = await app.inject({
    method: 'GET', url: '/tasks', headers: { authorization: 'Bearer nope' },
  });
  expect(r.statusCode).toBe(401);
});

// Required test 14
it('returns exact titles', async () => {
  const raw = 'Offer Neil Instagram and Facebook package for $100';
  await createTask(db, { title: raw, spaceId });
  const r = await app.inject({ method: 'GET', url: '/tasks', headers: auth });
  expect(r.statusCode).toBe(200);
  expect(r.json().tasks[0].title).toBe(raw);
});

it('preserves curly apostrophes and em dashes exactly', async () => {
  for (const raw of [
    'Waiting on Milltown’s reply to the email proposal',
    'Secure Logic — three-month honeymoon check-in with Marty',
  ]) {
    const r = await app.inject({
      method: 'POST', url: '/tasks', headers: auth,
      payload: { title: raw, space_id: spaceId },
    });
    expect(r.json().task.title).toBe(raw);
  }
});

it('creates a task with the exact title supplied', async () => {
  const raw = 'Consolidate 401(k): move Corebridge to Fidelity';
  const r = await app.inject({
    method: 'POST', url: '/tasks', headers: auth,
    payload: { title: raw, space_id: spaceId },
  });
  expect(r.statusCode).toBe(201);
  expect(r.json().task.title).toBe(raw);
});

// Required test 15
it('offers no route that can change a title', async () => {
  const task = await createTask(db, { title: 'Original exact title', spaceId });

  const moved = await app.inject({
    method: 'POST', url: `/tasks/${task.id}/move`, headers: auth,
    payload: { status: 'waiting', title: 'AI-rewritten title' },
  });
  expect(moved.statusCode).toBe(200);
  expect(moved.json().task.title).toBe('Original exact title');

  for (const method of ['PATCH', 'PUT'] as const) {
    const r = await app.inject({ method, url: `/tasks/${task.id}`, headers: auth });
    expect([404, 405]).toContain(r.statusCode);
  }
});

it('completes and reopens a task idempotently', async () => {
  const task = await createTask(db, { title: 'Call Neil', spaceId });
  const a = await app.inject({ method: 'POST', url: `/tasks/${task.id}/complete`, headers: auth });
  const b = await app.inject({ method: 'POST', url: `/tasks/${task.id}/complete`, headers: auth });
  expect(a.json().task.completed_at).toBe(b.json().task.completed_at);

  const c = await app.inject({ method: 'POST', url: `/tasks/${task.id}/reopen`, headers: auth });
  expect(c.json().task.status).toBe('open');
  expect(c.json().task.completed_at).toBeNull();
});

// Required test 17
it('rejects a malformed task id with 400, not 500', async () => {
  const r = await app.inject({
    method: 'POST', url: '/tasks/not-a-uuid/complete', headers: auth,
  });
  expect(r.statusCode).toBe(400);
});

it('404s a well-formed unknown id', async () => {
  const r = await app.inject({
    method: 'POST', url: '/tasks/00000000-0000-4000-8000-000000000000/complete', headers: auth,
  });
  expect(r.statusCode).toBe(404);
});

it('rejects a create with no title or no space', async () => {
  expect((await app.inject({
    method: 'POST', url: '/tasks', headers: auth, payload: { space_id: spaceId },
  })).statusCode).toBe(400);
  expect((await app.inject({
    method: 'POST', url: '/tasks', headers: auth, payload: { title: 'X' },
  })).statusCode).toBe(400);
});

it('serves spaces, waiting, and counts', async () => {
  const t = await createTask(db, { title: 'W', spaceId });
  await app.inject({
    method: 'POST', url: `/tasks/${t.id}/move`, headers: auth,
    payload: { status: 'waiting', waiting_on: 'Neil' },
  });
  expect((await app.inject({ method: 'GET', url: '/spaces', headers: auth })).json().spaces)
    .toHaveLength(12);
  expect((await app.inject({ method: 'GET', url: '/waiting', headers: auth })).json().tasks[0].waiting_on)
    .toBe('Neil');
  expect((await app.inject({ method: 'GET', url: '/counts', headers: auth })).json().counts[0].waiting)
    .toBe(1);
});

it('filters the task list by space and actionable status', async () => {
  await createTask(db, { title: 'NL task', spaceId });
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM spaces WHERE name = 'Marketing'`);
  await createTask(db, { title: 'Mkt task', spaceId: rows[0]!.id });
  const r = await app.inject({
    method: 'GET', url: `/tasks?space_id=${spaceId}&actionable=true`, headers: auth,
  });
  expect(r.json().tasks.map((t: { title: string }) => t.title)).toEqual(['NL task']);
});

it('returns 503 when no API token is configured, rather than allowing access', async () => {
  const open = buildServer({ db, apiToken: null });
  expect((await open.inject({ method: 'GET', url: '/tasks' })).statusCode).toBe(503);
  await open.close();
});

// --- Phase 2: channel-aware context routes ---

const mapChannel = (channelId: string, name: string, space: string) =>
  db.query(
    `INSERT INTO channel_space_map (slack_channel_id, slack_channel_name, space_id)
     SELECT $1, $2, id FROM spaces WHERE name = $3`,
    [channelId, name, space]
  );

it('resolves a channel to its Space', async () => {
  await mapChannel('C_SECURE', '#client-secure-logic', 'Client - Secure Logic');
  const r = await app.inject({ method: 'GET', url: '/context/C_SECURE/space', headers: auth });
  expect(r.json().space.name).toBe('Client - Secure Logic');
  expect(r.json().mapped).toBe(true);
  expect(r.json().channel_name).toBe('#client-secure-logic');
});

it('reports an unmapped channel as Inbox and unmapped', async () => {
  const r = await app.inject({ method: 'GET', url: '/context/C_NOPE/space', headers: auth });
  expect(r.json().mapped).toBe(false);
  expect(r.json().space.name).toBe('Inbox');
});

it('creates a task for a channel context with a byte-exact title', async () => {
  await mapChannel('C_SECURE', '#client-secure-logic', 'Client - Secure Logic');
  const raw = 'update the contact form';
  const r = await app.inject({
    method: 'POST', url: '/context/C_SECURE/tasks', headers: auth, payload: { title: raw },
  });
  expect(r.statusCode).toBe(201);
  expect(r.json().task.title).toBe(raw);
  expect(r.json().space.name).toBe('Client - Secure Logic');
  expect(r.json().resolved_from).toBe('channel');
  expect(r.json().task.source_channel_id).toBe('C_SECURE');
});

it('lets an explicit destination override the channel mapping', async () => {
  await mapChannel('C_SECURE', '#client-secure-logic', 'Client - Secure Logic');
  const r = await app.inject({
    method: 'POST', url: '/context/C_SECURE/tasks', headers: auth,
    payload: { title: 'review pricing', space: 'Agency / Internal' },
  });
  expect(r.json().space.name).toBe('Agency / Internal');
  expect(r.json().resolved_from).toBe('explicit');
});

it('rejects an unknown explicit destination with 400 and the valid options', async () => {
  await mapChannel('C_SECURE', '#client-secure-logic', 'Client - Secure Logic');
  const r = await app.inject({
    method: 'POST', url: '/context/C_SECURE/tasks', headers: auth,
    payload: { title: 'X', space: 'Some Other Client' },
  });
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toBe('unknown_space');
  expect(r.json().available).toContain('Client - Secure Logic');

  const all = await app.inject({ method: 'GET', url: '/tasks', headers: auth });
  expect(all.json().tasks).toHaveLength(0);
});

it('lists tasks for a channel context, excluding waiting and completed by default', async () => {
  await mapChannel('C_SECURE', '#client-secure-logic', 'Client - Secure Logic');
  const mk = (title: string) => app.inject({
    method: 'POST', url: '/context/C_SECURE/tasks', headers: auth, payload: { title },
  });
  await mk('Open one');
  const w = (await mk('Waiting one')).json().task;
  const c = (await mk('Done one')).json().task;
  await app.inject({
    method: 'POST', url: `/tasks/${w.id}/move`, headers: auth, payload: { status: 'waiting' },
  });
  await app.inject({ method: 'POST', url: `/tasks/${c.id}/complete`, headers: auth });

  const bare = await app.inject({ method: 'GET', url: '/context/C_SECURE/tasks', headers: auth });
  expect(bare.json().tasks.map((t: { title: string }) => t.title)).toEqual(['Open one']);

  const withWaiting = await app.inject({
    method: 'GET', url: '/context/C_SECURE/tasks?include_waiting=true', headers: auth,
  });
  expect(withWaiting.json().tasks).toHaveLength(2);
});

it('routes an unmapped channel to Inbox without inferring from the channel id', async () => {
  const r = await app.inject({
    method: 'POST', url: '/context/C_client_secure_logic/tasks', headers: auth,
    payload: { title: 'Buy a new vehicle' },
  });
  expect(r.json().space.name).toBe('Inbox');
  expect(r.json().resolved_from).toBe('inbox');
});

it('exposes the channel map for review', async () => {
  await mapChannel('C_AGENCY', '#agency-ops', 'Agency / Internal');
  const r = await app.inject({ method: 'GET', url: '/channel-map', headers: auth });
  expect(r.json().channels).toEqual([
    { channelId: 'C_AGENCY', channelName: '#agency-ops', spaceName: 'Agency / Internal' },
  ]);
});

it('requires a title on the context create route', async () => {
  const r = await app.inject({
    method: 'POST', url: '/context/C_SECURE/tasks', headers: auth, payload: {},
  });
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toBe('title_required');
});

// --- details column, approved 2026-09-09 ---

it('round-trips details verbatim through create and read', async () => {
  const details = 'Workstream: onboarding\nNext actor: Joshua\n\nBoundary: no live sends.';
  const created = await app.inject({
    method: 'POST', url: '/tasks', headers: auth,
    payload: { title: 'Automate onboarding AI primer', space_id: spaceId, details },
  });
  expect(created.json().task.details).toBe(details);
  const read = await app.inject({
    method: 'GET', url: `/tasks/${created.json().task.id}`, headers: auth,
  });
  expect(read.json().task.details).toBe(details);
});

it('accepts details on the channel-context create route', async () => {
  await mapChannel('C_SECURE', '#client-secure-logic', 'Client - Secure Logic');
  const r = await app.inject({
    method: 'POST', url: '/context/C_SECURE/tasks', headers: auth,
    payload: { title: 'X', details: 'context notes' },
  });
  expect(r.json().task.details).toBe('context notes');
});

it('offers no route that can change details', async () => {
  const created = await app.inject({
    method: 'POST', url: '/tasks', headers: auth,
    payload: { title: 'X', space_id: spaceId, details: 'original' },
  });
  const id = created.json().task.id;
  const moved = await app.inject({
    method: 'POST', url: `/tasks/${id}/move`, headers: auth,
    payload: { status: 'waiting', details: 'rewritten' },
  });
  expect(moved.json().task.details).toBe('original');
});

it('resolves the Personal tasks alias and Music as a Space', async () => {
  const alias = await app.inject({
    method: 'POST', url: '/context/C_NONE/tasks', headers: auth,
    payload: { title: 'Reflect on control', space: 'Personal tasks' },
  });
  expect(alias.json().space.name).toBe('Personal');

  const music = await app.inject({
    method: 'POST', url: '/context/C_NONE/tasks', headers: auth,
    payload: { title: 'Get and make new merch', space: 'Music' },
  });
  expect(music.json().space.name).toBe('Music');
});

// Regression: ISSUE-002 / ISSUE-003 — bad input returned 500 instead of a
// validation error or a safe default.
// Found by /qa on 2026-09-09
// Report: .gstack/qa-reports/qa-report-team-riley-tasks-2026-09-09.md
it('returns 400 for an unparseable due_at on both create routes', async () => {
  const a = await app.inject({
    method: 'POST', url: '/tasks', headers: auth,
    payload: { title: 'X', space_id: spaceId, due_at: 'not-a-date' },
  });
  expect(a.statusCode).toBe(400);
  expect(a.json().error).toBe('invalid_due_at');

  const b = await app.inject({
    method: 'POST', url: '/context/C_NONE/tasks', headers: auth,
    payload: { title: 'X', due_at: 'garbage' },
  });
  expect(b.statusCode).toBe(400);
  expect(b.json().error).toBe('invalid_due_at');
});

it('ignores a non-numeric limit instead of erroring', async () => {
  await createTask(db, { title: 'A', spaceId });
  for (const q of ['limit=abc', 'limit=', 'limit=-1', 'limit=NaN', 'limit=1e999']) {
    const r = await app.inject({ method: 'GET', url: `/tasks?${q}`, headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.json().tasks).toHaveLength(1);
  }
});

// Regression: ISSUE-007 — the bearer token used a plain !== compare while the
// Slack signature path correctly used timingSafeEqual.
// Found by /qa on 2026-09-09
// Report: .gstack/qa-reports/qa-report-team-riley-tasks-2026-09-09.md
it('rejects tokens of every wrong shape without leaking length via error', async () => {
  for (const header of [
    '', 'Bearer', 'Bearer ', 'Bearer s', 'Bearer secret-toke', 'Bearer secret-tokenn',
    'secret-token', 'Basic secret-token', 'bearer secret-token',
  ]) {
    const r = await app.inject({
      method: 'GET', url: '/tasks', headers: { authorization: header },
    });
    expect(r.statusCode).toBe(401);
  }
  const ok = await app.inject({
    method: 'GET', url: '/tasks', headers: { authorization: 'Bearer secret-token' },
  });
  expect(ok.statusCode).toBe(200);
});

// --- details update route ---

it('updates details and leaves the title untouched', async () => {
  const t = await createTask(db, { title: 'Exact original title', spaceId, details: 'a' });
  const r = await app.inject({
    method: 'POST', url: `/tasks/${t.id}/details`, headers: auth,
    payload: { details: 'b' },
  });
  expect(r.statusCode).toBe(200);
  expect(r.json().task.details).toBe('b');
  expect(r.json().task.title).toBe('Exact original title');
});

it('clears details with null and rejects a non-string value', async () => {
  const t = await createTask(db, { title: 'X', spaceId, details: 'a' });
  const cleared = await app.inject({
    method: 'POST', url: `/tasks/${t.id}/details`, headers: auth, payload: { details: null },
  });
  expect(cleared.json().task.details).toBeNull();

  const bad = await app.inject({
    method: 'POST', url: `/tasks/${t.id}/details`, headers: auth, payload: { details: 42 },
  });
  expect(bad.statusCode).toBe(400);
});

it('still has no route that can change a title, details route included', async () => {
  const t = await createTask(db, { title: 'Exact original title', spaceId });
  const r = await app.inject({
    method: 'POST', url: `/tasks/${t.id}/details`, headers: auth,
    payload: { details: 'notes', title: 'AI-REWRITTEN' },
  });
  expect(r.json().task.title).toBe('Exact original title');
});
