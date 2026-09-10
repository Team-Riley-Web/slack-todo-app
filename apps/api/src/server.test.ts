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
    .toHaveLength(11);
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
