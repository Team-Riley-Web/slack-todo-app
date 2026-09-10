export interface Db {
  /** Parameterized single-statement query (extended protocol). */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /**
   * Multi-statement script with no parameters (simple protocol).
   * Required for migrations: PGlite's extended protocol rejects
   * "multiple commands into a prepared statement".
   */
  exec(sql: string): Promise<void>;
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
    close: () => pglite.close(),
  };
}
