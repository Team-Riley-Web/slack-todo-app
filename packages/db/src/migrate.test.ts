import { describe, it, expect } from 'vitest';
import { createTestDb } from './testing.js';

describe('migrations', () => {
  it('creates every Phase 1 table', async () => {
    const db = await createTestDb();
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'channel_space_map', 'import_audit', 'import_batches', 'import_staging',
      'lists', 'processed_interactions', 'schema_migrations', 'slack_cards',
      'space_aliases', 'spaces', 'task_events', 'tasks',
    ]);
    await db.close();
  });

  it('rejects a completed task with no completed_at', async () => {
    const db = await createTestDb();
    await db.query(`INSERT INTO spaces (name, slug) VALUES ('X', 'x')`);
    await expect(
      db.query(
        `INSERT INTO tasks (title, space_id, status)
         SELECT 'T', id, 'completed' FROM spaces WHERE slug = 'x'`
      )
    ).rejects.toThrow();
    await db.close();
  });

  it('is idempotent when run twice', async () => {
    const db = await createTestDb();
    const { migrate } = await import('./migrate.js');
    await expect(migrate(db)).resolves.toBeUndefined();
    await db.close();
  });
});
