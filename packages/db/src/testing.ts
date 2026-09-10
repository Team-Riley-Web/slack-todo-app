import { createDb, type Db } from './client.js';
import { migrate } from './migrate.js';

/** A fresh in-memory Postgres, migrated. One per test file. */
export async function createTestDb(): Promise<Db> {
  const db = await createDb('memory://');
  await migrate(db);
  return db;
}
