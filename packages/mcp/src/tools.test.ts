import { it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { buildTools, TOOL_NAMES } from './tools.js';

let db: Db;
let tools: Map<string, (a: Record<string, unknown>) => Promise<any>>;
let spaceId: string;

beforeEach(async () => {
  db = await createTestDb();
  tools = new Map(buildTools(db).map((t) => [t.name, t.handler]));
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM spaces WHERE name = 'Client - Nazareth Law'`
  );
  spaceId = rows[0]!.id;
});
afterEach(async () => { await db.close(); });

const call = (name: string, args: Record<string, unknown> = {}) => tools.get(name)!(args);

it('exposes exactly the eight contracted tools', () => {
  expect([...TOOL_NAMES].sort()).toEqual([
    'complete_task', 'create_task', 'get_task', 'get_task_counts',
    'list_spaces', 'list_tasks', 'list_waiting', 'move_task',
  ]);
  expect(new Set(buildTools(db).map((t) => t.name))).toEqual(new Set(TOOL_NAMES));
});

// Required test 18
it('exposes no tool that can rename a task', () => {
  expect(TOOL_NAMES.some((n) => /title|rename|edit|update/i.test(n))).toBe(false);
});

// Required test 14
it('returns exact titles', async () => {
  const raw = 'Offer Neil Instagram and Facebook package for $100';
  await call('create_task', { title: raw, space_id: spaceId });
  expect((await call('list_tasks', {})).tasks[0].title).toBe(raw);
});

// Required test 15
it('ignores a title passed to move_task', async () => {
  const { task } = await call('create_task', { title: 'Original exact title', space_id: spaceId });
  await call('move_task', { task_id: task.id, status: 'waiting', title: 'AI-rewritten' });
  const { task: read } = await call('get_task', { task_id: task.id });
  expect(read.title).toBe('Original exact title');
  expect(read.status).toBe('waiting');
});

it('rejects create_task with a missing or non-string title', async () => {
  await expect(call('create_task', { space_id: spaceId })).rejects.toThrow();
  await expect(call('create_task', { title: 42, space_id: spaceId })).rejects.toThrow();
  await expect(call('create_task', { title: 'X' })).rejects.toThrow();
});

// Required test 17
it('rejects a malformed task id', async () => {
  await expect(call('complete_task', { task_id: 'not-a-uuid' })).rejects.toThrow();
  await expect(call('get_task', { task_id: '../../etc/passwd' })).rejects.toThrow();
});

it('completes idempotently', async () => {
  const { task } = await call('create_task', { title: 'Call Neil', space_id: spaceId });
  const a = await call('complete_task', { task_id: task.id });
  const b = await call('complete_task', { task_id: task.id });
  expect(a.task.completed_at).toEqual(b.task.completed_at);
});

it('records hermes as the source platform on tasks it creates', async () => {
  const { task } = await call('create_task', { title: 'From Hermes', space_id: spaceId });
  expect(task.source_platform).toBe('hermes');
});

it('reports counts and waiting separately from actionable tasks', async () => {
  const { task } = await call('create_task', { title: 'W', space_id: spaceId });
  await call('move_task', { task_id: task.id, status: 'waiting', waiting_on: 'Neil' });
  expect((await call('list_tasks', { actionable_only: true })).tasks).toHaveLength(0);
  expect((await call('list_waiting', {})).tasks[0].waiting_on).toBe('Neil');
  expect((await call('get_task_counts', {})).counts[0].waiting).toBe(1);
});

it('lists all spaces', async () => {
  expect((await call('list_spaces', {})).spaces).toHaveLength(11);
});

it('states the verbatim-title rule in the create_task description', () => {
  const create = buildTools(db).find((t) => t.name === 'create_task')!;
  expect(create.description.toLowerCase()).toContain('verbatim');
  expect(create.description.toLowerCase()).toContain('never be changed');
});
