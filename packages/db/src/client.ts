export interface Db {
  /** Parameterized single-statement query (extended protocol). */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /**
   * Multi-statement script with no parameters (simple protocol).
   * Required for migrations: PGlite's extended protocol rejects
   * "multiple commands into a prepared statement".
   */
  exec(sql: string): Promise<void>;
  /**
   * Runs `fn` inside one transaction on a single pinned connection, so BEGIN
   * and COMMIT actually bracket the work.
   *
   * Without this, `query` runs against a POOL: consecutive calls can land on
   * different connections, and a BEGIN issued through `query` would not
   * bracket the statements that followed it. A throw rolls everything back.
   * Nested calls join the same transaction rather than opening a second one.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createDb(url = process.env.DATABASE_URL): Promise<Db> {
  if (url && /^postgres(ql)?:\/\//.test(url)) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url });
    return {
      async query(sql, params) {
        const r = await pool.query(sql, params as never[]);
        return { rows: r.rows as never[] };
      },
      async exec(sql) {
        await pool.query(sql);
      },
      async transaction(fn) {
        const client = await pool.connect();
        const tx: Db = {
          async query(sql, params) {
            const r = await client.query(sql, params as never[]);
            return { rows: r.rows as never[] };
          },
          async exec(sql) { await client.query(sql); },
          transaction: (inner) => inner(tx), // already inside one
          async close() { /* the outer transaction owns this client */ },
        };
        try {
          await client.query('BEGIN');
          const result = await fn(tx);
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const pglite = url && url !== 'memory://' ? new PGlite(url) : new PGlite();
  return {
    async query(sql, params) {
      const r = await pglite.query(sql, params as unknown[]);
      return { rows: r.rows as never[] };
    },
    async exec(sql) {
      await pglite.exec(sql);
    },
    async transaction(fn) {
      // PGlite resolves undefined on rollback, but a rollback here always
      // throws first, so the non-undefined cast is sound.
      return pglite.transaction(async (t) => {
        const tx: Db = {
          async query(sql, params) {
            const r = await t.query(sql, params as unknown[]);
            return { rows: r.rows as never[] };
          },
          async exec(sql) { await t.exec(sql); },
          transaction: (inner) => inner(tx),
          async close() { /* no-op inside a transaction */ },
        };
        return fn(tx);
      }) as Promise<ReturnType<typeof fn>> as never;
    },
    close: () => pglite.close(),
  };
}
