import { createDb, type Db } from '@tr/db';

let cached: Promise<Db> | null = null;

/**
 * One database handle per process.
 *
 * On Vercel a warm serverless process is reused between requests, so holding
 * the pool at module scope avoids opening a new one per request.
 *
 * Two deliberate constraints:
 *
 * 1. **Postgres only.** PGlite ships its engine as WebAssembly and reads that
 *    file at runtime; a bundled Next build breaks it with an opaque
 *    "path argument must be of type string" from deep inside PGlite. It stays
 *    the convenience for the Node processes and the test suite, and the web app
 *    talks to Postgres — which is its real target anyway. The check below turns
 *    a confusing WASM error into a sentence that says what to do.
 *
 * 2. **No migrations here.** They read SQL files from disk, which a bundle
 *    cannot resolve, and migrating from a request path means concurrent cold
 *    starts racing to alter the schema. Run `pnpm migrate` as a deploy step.
 */
export function getDb(): Promise<Db> {
  cached ??= (async () => {
    const url = process.env.DATABASE_URL?.trim();
    if (!url || !/^postgres(ql)?:\/\//.test(url)) {
      throw new Error(
        'The web app needs a Postgres DATABASE_URL (postgres://...). ' +
        'PGlite cannot run inside the bundled Next server. ' +
        'Use the Supabase connection string; see WEB.md.'
      );
    }
    return createDb(url);
  })();
  return cached;
}
