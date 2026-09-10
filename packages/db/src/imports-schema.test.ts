import { it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './testing.js';
import type { Db } from './client.js';

let db: Db;
let spaceId: string;
beforeEach(async () => {
  db = await createTestDb();
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM spaces WHERE name='Marketing'`);
  spaceId = rows[0]!.id;
});
afterEach(async () => { await db.close(); });

const batch = async (): Promise<string> => {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO import_batches (source_type, filename) VALUES ('csv','a.csv') RETURNING id`
  );
  return rows[0]!.id;
};

it('defaults a new batch to PARSED and rejects an unknown state', async () => {
  const id = await batch();
  const { rows } = await db.query<{ state: string }>(
    `SELECT state FROM import_batches WHERE id = $1`, [id]
  );
  expect(rows[0]!.state).toBe('PARSED');
  await expect(
    db.query(`UPDATE import_batches SET state='WHATEVER' WHERE id=$1`, [id])
  ).rejects.toThrow();
});

it('requires confirmed_by and confirmed_at together', async () => {
  const id = await batch();
  await expect(
    db.query(`UPDATE import_batches SET confirmed_at=now() WHERE id=$1`, [id])
  ).rejects.toThrow();
  await expect(
    db.query(`UPDATE import_batches SET confirmed_at=now(), confirmed_by='U1' WHERE id=$1`, [id])
  ).resolves.toBeTruthy();
});

it('enforces one source record per platform', async () => {
  await db.query(
    `INSERT INTO tasks (title, space_id, source_platform, source_external_id)
     VALUES ('A', $1, 'workast', 'w-1')`, [spaceId]
  );
  await expect(db.query(
    `INSERT INTO tasks (title, space_id, source_platform, source_external_id)
     VALUES ('A again', $1, 'workast', 'w-1')`, [spaceId]
  )).rejects.toThrow();
  // The same id on a different platform is a different record.
  await expect(db.query(
    `INSERT INTO tasks (title, space_id, source_platform, source_external_id)
     VALUES ('A', $1, 'kanban', 'w-1')`, [spaceId]
  )).resolves.toBeTruthy();
});

it('leaves ordinary Slack tasks exempt from the unique index', async () => {
  for (let i = 0; i < 3; i += 1) {
    await db.query(`INSERT INTO tasks (title, space_id) VALUES ('same', $1)`, [spaceId]);
  }
  const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks`);
  expect(rows[0]!.n).toBe(3);
});

it('rejects an unknown verdict or audit action', async () => {
  const id = await batch();
  await expect(db.query(
    `INSERT INTO import_staging (batch_id, row_number, source_type, title, verdict)
     VALUES ($1, 1, 'csv', 'T', 'MAYBE')`, [id]
  )).rejects.toThrow();
  await expect(db.query(
    `INSERT INTO import_audit (batch_id, source_type, action) VALUES ($1,'csv','MERGED')`, [id]
  )).rejects.toThrow();
});

it('keeps an audit row after its task is deleted', async () => {
  const id = await batch();
  const { rows: t } = await db.query<{ id: string }>(
    `INSERT INTO tasks (title, space_id) VALUES ('gone soon', $1) RETURNING id`, [spaceId]
  );
  await db.query(
    `INSERT INTO import_audit (batch_id, source_type, source_record_id, canonical_task_id, action)
     VALUES ($1,'csv','r-1',$2,'IMPORTED')`, [id, t[0]!.id]
  );
  await db.query(`DELETE FROM tasks WHERE id = $1`, [t[0]!.id]);
  const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM import_audit`);
  expect(rows[0]!.n).toBe(1); // no FK, so rollback cannot destroy the record
});

it('cascades staging and audit rows when a batch is deleted', async () => {
  const id = await batch();
  await db.query(
    `INSERT INTO import_staging (batch_id, row_number, source_type, title)
     VALUES ($1, 1, 'csv', 'T')`, [id]
  );
  await db.query(
    `INSERT INTO import_audit (batch_id, source_type, action) VALUES ($1,'csv','IMPORTED')`, [id]
  );
  await db.query(`DELETE FROM import_batches WHERE id = $1`, [id]);
  const { rows } = await db.query<{ s: number; a: number }>(
    `SELECT (SELECT COUNT(*)::int FROM import_staging) AS s,
            (SELECT COUNT(*)::int FROM import_audit) AS a`
  );
  expect(rows[0]).toEqual({ s: 0, a: 0 });
});

it('enforces one staging row per row number within a batch', async () => {
  const id = await batch();
  await db.query(
    `INSERT INTO import_staging (batch_id, row_number, source_type, title)
     VALUES ($1, 1, 'csv', 'first')`, [id]
  );
  await expect(db.query(
    `INSERT INTO import_staging (batch_id, row_number, source_type, title)
     VALUES ($1, 1, 'csv', 'second')`, [id]
  )).rejects.toThrow();
});

it('accepts the edited task event', async () => {
  const { rows: t } = await db.query<{ id: string }>(
    `INSERT INTO tasks (title, space_id) VALUES ('T', $1) RETURNING id`, [spaceId]
  );
  await expect(db.query(
    `INSERT INTO task_events (task_id, event, source) VALUES ($1,'edited','slack')`, [t[0]!.id]
  )).resolves.toBeTruthy();
});

it('rejects an unknown source_type on a batch', async () => {
  await expect(db.query(
    `INSERT INTO import_batches (source_type) VALUES ('trello')`
  )).rejects.toThrow();
});
