import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './client.js';

/**
 * Resolved lazily, inside migrate(), NOT as a top-level constant.
 *
 * As a top-level constant this ran on merely importing @tr/db, and a bundled
 * Next build does not give `import.meta.url` a real file URL — so every web
 * request failed with an opaque "path argument must be of type string" before
 * any of our code ran. Nothing that only migrations need should execute at
 * import time.
 */
function migrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
}

export async function migrate(db: Db): Promise<void> {
  const dir = migrationsDir();
  await db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());`
  );
  const { rows } = await db.query<{ name: string }>(`SELECT name FROM schema_migrations`);
  const applied = new Set(rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    await db.exec(sql);
    await db.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
  }
}
