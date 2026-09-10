import { it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { listSpaces, deleteSpace } from './spaces.js';
import { createTask, completeTask } from './tasks.js';
import { mapChannelToSpace } from './channel-map.js';
import { getSpaceForChannel } from './context.js';

let db: Db;
const actor = { id: 'U_JOSH', source: 'test' };
const byName = async (name: string) =>
  (await listSpaces(db)).find((s) => s.name === name)!;

beforeEach(async () => { db = await createTestDb(); });
afterEach(async () => { await db.close(); });

it('lists Inbox first, then alphabetical by the name as displayed', async () => {
  // Sorting by the canonical name put the whole "Client - " block under C,
  // landing between "Agency / Internal" and "Marketing" while the screen
  // showed "CFC Skincare ... Yoga Farm". The sort key has to match the text.
  const shown = (await listSpaces(db)).map((s) => s.name.replace(/^Client - /, ''));
  expect(shown[0]).toBe('Inbox');

  const rest = shown.slice(1);
  expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
  expect(rest).toContain('Yoga Farm');
  expect(rest.indexOf('Marketing')).toBeLessThan(rest.indexOf('Yoga Farm'));
});

it('deletes an empty Space', async () => {
  const yoga = await byName('Client - Yoga Farm');
  const result = await deleteSpace(db, yoga.id);
  expect(result.ok).toBe(true);
  expect((await listSpaces(db)).some((s) => s.id === yoga.id)).toBe(false);
});

it('removes the lists that belonged to it', async () => {
  const yoga = await byName('Client - Yoga Farm');
  const result = await deleteSpace(db, yoga.id);
  // Seeded with Open and Waiting / Blocked.
  expect(result.removed?.lists).toBe(2);
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM lists WHERE space_id = $1`, [yoga.id]
  );
  expect(rows[0]!.n).toBe(0);
});

it('removes a channel mapping pointing at it, so captures fall back to Inbox', async () => {
  const yoga = await byName('Client - Yoga Farm');
  await mapChannelToSpace(db, {
    channelId: 'C_YOGA', channelName: '#client-yoga-farm', spaceName: 'Client - Yoga Farm',
  });

  const result = await deleteSpace(db, yoga.id);
  expect(result.ok).toBe(true);
  expect(result.removed?.channelMappings).toBe(1);

  // A mapping to a Space that no longer exists would be worse than none.
  const context = await getSpaceForChannel(db, 'C_YOGA');
  expect(context.mapped).toBe(false);
  expect(context.space.is_inbox).toBe(true);
});

it('removes an alias pointing at it', async () => {
  const personal = await byName('Personal');
  const result = await deleteSpace(db, personal.id);
  expect(result.ok).toBe(true);
  // Migration 004 seeds 'personal tasks' -> Personal.
  expect(result.removed?.aliases).toBe(1);
});

it('refuses a Space that still holds an open task, and changes nothing', async () => {
  const marketing = await byName('Marketing');
  await createTask(db, { title: 'Still here', spaceId: marketing.id });

  const result = await deleteSpace(db, marketing.id);
  expect(result.ok).toBe(false);
  expect(result.error).toContain('1 task');
  expect((await listSpaces(db)).some((s) => s.id === marketing.id)).toBe(true);
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM lists WHERE space_id = $1`, [marketing.id]
  );
  expect(rows[0]!.n).toBe(2);
});

it('refuses on completed tasks too, because those are history', async () => {
  const marketing = await byName('Marketing');
  const task = await createTask(db, { title: 'Done long ago', spaceId: marketing.id });
  await completeTask(db, task.id, actor);

  const result = await deleteSpace(db, marketing.id);
  expect(result.ok).toBe(false);
  expect(result.error).toContain('including completed');
});

it('refuses to delete Inbox, whatever else is true', async () => {
  const inbox = (await listSpaces(db)).find((s) => s.is_inbox)!;
  const result = await deleteSpace(db, inbox.id);
  expect(result.ok).toBe(false);
  expect(result.error).toContain('Inbox cannot be deleted');
  expect((await listSpaces(db)).some((s) => s.is_inbox)).toBe(true);
});

it('clears an import staging pointer but keeps the source text', async () => {
  const yoga = await byName('Client - Yoga Farm');
  const { rows: batch } = await db.query<{ id: string }>(
    `INSERT INTO import_batches (source_type, filename) VALUES ('csv','x.csv') RETURNING id`
  );
  await db.query(
    `INSERT INTO import_staging
       (batch_id, row_number, source_type, title, space, resolved_space_id)
     VALUES ($1, 1, 'csv', 'A task', 'Yoga Farm', $2)`,
    [batch[0]!.id, yoga.id]
  );

  expect((await deleteSpace(db, yoga.id)).ok).toBe(true);
  const { rows } = await db.query<{ space: string; resolved_space_id: string | null }>(
    `SELECT space, resolved_space_id FROM import_staging WHERE batch_id = $1`,
    [batch[0]!.id]
  );
  expect(rows[0]!.resolved_space_id).toBeNull();
  // The record of what was submitted survives.
  expect(rows[0]!.space).toBe('Yoga Farm');
});

it('reports a Space that no longer exists rather than throwing', async () => {
  const result = await deleteSpace(db, '00000000-0000-4000-8000-000000000000');
  expect(result.ok).toBe(false);
  expect(result.error).toContain('no longer exists');
});

it('rejects a blank id', async () => {
  expect((await deleteSpace(db, '   ')).ok).toBe(false);
});
