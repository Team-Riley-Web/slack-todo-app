import { it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './testing.js';
import type { Db } from './client.js';

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
  await db.exec(`CREATE TABLE t (id serial PRIMARY KEY, v text);`);
});
afterEach(async () => { await db.close(); });

const count = async (d: Db = db) => {
  const { rows } = await d.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM t`);
  return rows[0]!.n;
};

it('commits work when the callback resolves', async () => {
  const result = await db.transaction(async (tx) => {
    await tx.query(`INSERT INTO t (v) VALUES ($1)`, ['a']);
    await tx.query(`INSERT INTO t (v) VALUES ($1)`, ['b']);
    return 'done';
  });
  expect(result).toBe('done');
  expect(await count()).toBe(2);
});

it('rolls everything back when the callback throws', async () => {
  await expect(db.transaction(async (tx) => {
    await tx.query(`INSERT INTO t (v) VALUES ($1)`, ['a']);
    await tx.query(`INSERT INTO t (v) VALUES ($1)`, ['b']);
    throw new Error('boom');
  })).rejects.toThrow('boom');
  expect(await count()).toBe(0); // not 2, and crucially not 1
});

it('rolls back a partial write caused by a constraint violation', async () => {
  await db.exec(`CREATE TABLE u (id int PRIMARY KEY);`);
  await expect(db.transaction(async (tx) => {
    await tx.query(`INSERT INTO t (v) VALUES ('kept?')`);
    await tx.query(`INSERT INTO u (id) VALUES (1)`);
    await tx.query(`INSERT INTO u (id) VALUES (1)`); // duplicate key
  })).rejects.toThrow();
  expect(await count()).toBe(0);
});

it('sees its own uncommitted writes inside the callback', async () => {
  await db.transaction(async (tx) => {
    await tx.query(`INSERT INTO t (v) VALUES ('x')`);
    expect(await count(tx)).toBe(1);
  });
  expect(await count()).toBe(1);
});

it('treats a nested transaction as the same transaction', async () => {
  await expect(db.transaction(async (tx) => {
    await tx.query(`INSERT INTO t (v) VALUES ('outer')`);
    await tx.transaction(async (inner) => {
      await inner.query(`INSERT INTO t (v) VALUES ('inner')`);
    });
    throw new Error('abort both');
  })).rejects.toThrow('abort both');
  expect(await count()).toBe(0);
});

it('ignores close() on a transaction handle', async () => {
  await db.transaction(async (tx) => {
    await tx.close();
    await tx.query(`INSERT INTO t (v) VALUES ('still works')`);
  });
  expect(await count()).toBe(1);
});

it('returns the callback value through', async () => {
  expect(await db.transaction(async () => 42)).toBe(42);
  expect(await db.transaction(async () => ({ a: 1 }))).toEqual({ a: 1 });
});

it('supports exec inside a transaction', async () => {
  await db.transaction(async (tx) => {
    await tx.exec(`INSERT INTO t (v) VALUES ('via exec');`);
  });
  expect(await count()).toBe(1);
});
