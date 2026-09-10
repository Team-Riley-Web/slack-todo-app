import { createDb, migrate, type Db } from '@tr/db';

let cached: Promise<Db> | null = null;

/**
 * One database handle per process.
 *
 * On Vercel each serverless invocation may reuse a warm process, so holding the
 * pool at module scope avoids opening a new one per request. `migrate` records
 * what it has applied, so calling it on a cold start is a no-op after the first.
 */
export function getDb(): Promise<Db> {
  cached ??= (async () => {
    const db = await createDb();
    await migrate(db);
    return db;
  })();
  return cached;
}
