import { it, expect, beforeEach, afterEach } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestDb } from './testing.js';
import type { Db } from './client.js';

/**
 * Migration 009 exists because Supabase publishes every table in `public`
 * through PostgREST, reachable with the anon key that ships in browser
 * bundles. These tests guard both halves of the lockdown, and — more
 * importantly — guard that the lockdown did not lock *us* out.
 */

let db: Db;
beforeEach(async () => { db = await createTestDb(); });
afterEach(async () => { await db.close(); });

it('has row level security enabled on every table', async () => {
  const { rows } = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND rowsecurity = false
      ORDER BY tablename`
  );
  expect(rows.map((r) => r.tablename)).toEqual([]);
});

it('still lets the owner read and write, because owners bypass RLS', async () => {
  // The failure this catches: enabling RLS with zero policies denies every row
  // to a non-owner. If our own connection were ever not the owner, every query
  // in the app would silently return nothing rather than error.
  const { rows: spaces } = await db.query<{ id: string }>(
    `SELECT id FROM spaces WHERE name = 'Marketing'`
  );
  expect(spaces).toHaveLength(1);

  const { rows: created } = await db.query<{ id: string; title: string }>(
    `INSERT INTO tasks (space_id, title, created_by, source_platform)
     VALUES ($1, 'rls check', 'U_TEST', 'slack') RETURNING id, title`,
    [spaces[0]!.id]
  );
  expect(created[0]!.title).toBe('rls check');

  const { rows: readBack } = await db.query(
    `SELECT id FROM tasks WHERE id = $1`, [created[0]!.id]
  );
  expect(readBack).toHaveLength(1);
});

it('grants no policy to anything, so a non-owner sees no rows', async () => {
  // Zero policies is the deny. A policy added later would be a deliberate
  // decision to expose data through the Supabase API, and should fail here
  // so it cannot happen by accident.
  const { rows } = await db.query<{ tablename: string; policyname: string }>(
    `SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'`
  );
  expect(rows).toEqual([]);
});

it('keeps every later migration from re-exposing the schema unguarded', async () => {
  // A migration added after 009 creates tables with RLS off. The first test
  // above catches that, but only if 009 stays last-applied-wins. It does not:
  // it is a one-time pass. So any new migration must enable RLS itself, and
  // this test names that requirement in the place someone will look.
  const dir = join(import.meta.dirname, '..', 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const later = files.filter((f) => f > '009_lock_down_api_roles.sql');

  for (const file of later) {
    const sql = await readFile(join(dir, file), 'utf8');
    const createsTable = /CREATE TABLE/i.test(sql);
    if (createsTable) {
      expect(
        /ENABLE ROW LEVEL SECURITY/i.test(sql),
        `${file} creates a table but never enables row level security`
      ).toBe(true);
    }
  }
});
