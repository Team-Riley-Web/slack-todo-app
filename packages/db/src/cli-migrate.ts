import { createDb } from './client.js';
import { migrate } from './migrate.js';

/**
 * Says which database it migrated, with the credentials stripped.
 *
 * `pnpm migrate` used to print "migrations applied" and nothing else. With no
 * DATABASE_URL in the environment, createDb falls back to an in-memory PGlite,
 * so the command cheerfully migrated a throwaway database and reported success
 * -- which is exactly what it looks like when it worked. WEB.md names this as
 * the pre-deploy step, so a silent no-op there is the worst possible failure:
 * the deploy proceeds against an unmigrated database.
 */
function describeTarget(url: string | undefined): string {
  const raw = url?.trim();
  if (!raw) return 'in-memory PGlite (no DATABASE_URL set — NOTHING WAS PERSISTED)';
  if (raw.startsWith('file://')) return raw;
  try {
    const parsed = new URL(raw);
    // Never the password, and never the user: the host and database name are
    // enough to tell "production" from "the one on my laptop".
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return 'an unparseable DATABASE_URL';
  }
}

const target = describeTarget(process.env.DATABASE_URL);
const db = await createDb();
await migrate(db);
await db.close();
console.log(`migrations applied to ${target}`);
