import { it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { listSpaces, deleteSpace, createSpace, setSpaceName } from './spaces.js';
import { createTask, completeTask } from './tasks.js';
import { mapChannelToSpace } from './channel-map.js';
import { getSpaceForChannel, findSpaceExact } from './context.js';

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

// --- creating a Space ---

it('creates a Space with a slug and the standard two lists', async () => {
  const result = await createSpace(db, 'Client - Rosario Landscaping');
  expect(result.ok).toBe(true);
  expect(result.existed).toBe(false);
  expect(result.space!.name).toBe('Client - Rosario Landscaping');
  expect(result.space!.slug).toBe('rosario-landscaping');
  expect(result.space!.is_inbox).toBe(false);

  const { rows } = await db.query<{ name: string }>(
    `SELECT name FROM lists WHERE space_id = $1 ORDER BY name`, [result.space!.id]
  );
  expect(rows.map((r) => r.name)).toEqual(['Open', 'Waiting / Blocked']);
});

it('stores the name as typed, apart from an outer trim', async () => {
  const result = await createSpace(db, '  Rosario  Landscaping  ');
  // Interior runs of whitespace collapse to one space; nothing else changes.
  expect(result.space!.name).toBe('Rosario Landscaping');
});

it('returns the existing Space rather than failing on a duplicate name', async () => {
  const first = await createSpace(db, 'Rosario');
  const second = await createSpace(db, 'rosario');
  expect(second.ok).toBe(true);
  expect(second.existed).toBe(true);
  expect(second.space!.id).toBe(first.space!.id);
});

it('does not add Client - for you', async () => {
  // Whether a Space is a client is the operator's call, not a naming rule.
  const result = await createSpace(db, 'Rosario Landscaping');
  expect(result.space!.name).toBe('Rosario Landscaping');
});

it('makes the slug unique when two names slug the same', async () => {
  const a = await createSpace(db, 'Rosario Landscaping');
  const b = await createSpace(db, 'Rosario  Landscaping!');
  expect(a.space!.slug).toBe('rosario-landscaping');
  expect(b.space!.slug).toBe('rosario-landscaping-2');
  expect(b.space!.id).not.toBe(a.space!.id);
});

it('does not collide with a seeded slug', async () => {
  // "Client - Marketing" strips to "marketing", which Marketing already has.
  const result = await createSpace(db, 'Client - Marketing');
  expect(result.ok).toBe(true);
  expect(result.space!.slug).toBe('marketing-2');
});

it('rejects a blank name and a name with no letters or digits', async () => {
  expect((await createSpace(db, '   ')).ok).toBe(false);
  expect((await createSpace(db, '!!!')).ok).toBe(false);
});

it('rejects a name beyond 80 characters rather than truncating it', async () => {
  const result = await createSpace(db, 'x'.repeat(81));
  expect(result.ok).toBe(false);
  expect(result.error).toContain('too long');
});

it('sorts a new Space into place, not onto the end', async () => {
  await createSpace(db, 'Client - Bravo');
  const shown = (await listSpaces(db)).map((s) => s.name.replace(/^Client - /, ''));
  const rest = shown.slice(1);
  expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
  expect(rest.indexOf('Bravo')).toBeLessThan(rest.indexOf('Marketing'));
});

it('creates a Space that can then be deleted while empty', async () => {
  const made = await createSpace(db, 'Temporary');
  expect((await deleteSpace(db, made.space!.id)).ok).toBe(true);
});

// --- renaming a Space ---

it('renames a Space and regenerates its slug', async () => {
  const music = await byName('Music');
  const r = await setSpaceName(db, music.id, 'Records');
  expect(r.ok).toBe(true);
  expect(r.space!.name).toBe('Records');
  // A slug still saying "music" on a Space called Records is its own lie.
  expect(r.space!.slug).toBe('records');
});

it('keeps the old name working, as an alias', async () => {
  // The reason this matters: findSpaceExact matches name and slug for
  // `/tasks <space>`, and config/channel-map.json names Spaces as strings.
  // A bare UPDATE would quietly break both.
  const music = await byName('Music');
  const r = await setSpaceName(db, music.id, 'Records');
  expect(r.aliased).toBe(true);

  const found = await findSpaceExact(db, 'Music');
  expect(found?.id).toBe(music.id);
  expect(found?.name).toBe('Records');
});

it('resolves the new name too', async () => {
  const music = await byName('Music');
  await setSpaceName(db, music.id, 'Records');
  expect((await findSpaceExact(db, 'Records'))?.id).toBe(music.id);
});

it('keeps a channel mapping pointing at the renamed Space', async () => {
  const music = await byName('Music');
  await mapChannelToSpace(db, { channelId: 'C_MUS', spaceName: 'Music' });
  await setSpaceName(db, music.id, 'Records');

  // The map stores a space_id, so it follows the rename without touching it.
  const context = await getSpaceForChannel(db, 'C_MUS');
  expect(context.mapped).toBe(true);
  expect(context.space.name).toBe('Records');
});

it('keeps tasks with the Space through a rename', async () => {
  const music = await byName('Music');
  const task = await createTask(db, { title: 'Mix the record', spaceId: music.id });
  await setSpaceName(db, music.id, 'Records');
  const { rows } = await db.query<{ space_id: string }>(
    `SELECT space_id FROM tasks WHERE id = $1`, [task.id]
  );
  expect(rows[0]!.space_id).toBe(music.id);
});

it('strips the client prefix from the new slug, as creation does', async () => {
  const music = await byName('Music');
  const r = await setSpaceName(db, music.id, 'Client - Rosario Landscaping');
  expect(r.space!.slug).toBe('rosario-landscaping');
});

it('refuses a name another Space already has', async () => {
  const music = await byName('Music');
  const r = await setSpaceName(db, music.id, 'marketing');
  expect(r.ok).toBe(false);
  expect(r.error).toContain('already called');
  expect((await byName('Music')).name).toBe('Music');
});

it('treats renaming to the same name as a no-op, not an error', async () => {
  const music = await byName('Music');
  const r = await setSpaceName(db, music.id, 'Music');
  expect(r.ok).toBe(true);
  expect(r.aliased).toBe(false);
});

it('rejects a blank name, a too-long name, and one with no letters', async () => {
  const music = await byName('Music');
  expect((await setSpaceName(db, music.id, '   ')).ok).toBe(false);
  expect((await setSpaceName(db, music.id, 'x'.repeat(81))).ok).toBe(false);
  expect((await setSpaceName(db, music.id, '!!!')).ok).toBe(false);
  expect((await byName('Music')).name).toBe('Music');
});

it('reports a Space that no longer exists', async () => {
  const r = await setSpaceName(db, '00000000-0000-4000-8000-000000000000', 'X');
  expect(r.ok).toBe(false);
  expect(r.error).toContain('no longer exists');
});

it('does not steal an alias another Space already owns', async () => {
  // 'personal tasks' is seeded as an alias of Personal by migration 004.
  const music = await byName('Music');
  await setSpaceName(db, music.id, 'Personal tasks');
  const r = await setSpaceName(db, music.id, 'Records');
  expect(r.ok).toBe(true);
  // The alias stays with Personal, so lookups do not become arbitrary.
  expect((await findSpaceExact(db, 'personal tasks'))?.name).toBe('Personal');
});
