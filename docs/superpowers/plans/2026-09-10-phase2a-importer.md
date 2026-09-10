# Phase 2A Implementation Plan — Importer, full-field editing, reporting

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A safe, idempotent, reversible importer for legacy task data, plus full-field task editing from a native Slack modal, plus read-only reporting queries for Hermes.

**Architecture:** A new `packages/importer` owns parse → stage → map → analyze → write → verify → rollback and calls `task-core` for every write, issuing no task SQL of its own. Adapters are pure functions (bytes in, staging rows out). All Slack surfaces use native Block Kit elements — `file_input`, `views.push`, `datetimepicker`, `radio_buttons`, `users_select`. Nothing reaches `tasks` before an explicit human confirmation.

**Tech Stack:** TypeScript (strict, ESM, NodeNext) · Node 24 · pnpm workspaces · Slack Bolt (Socket Mode) · PGlite / node-postgres · Vitest · `csv-parse` for CSV

**Spec:** `docs/superpowers/specs/2026-09-10-importer-and-editing-design.md`

## Global Constraints

- Import `title` is the source bytes, unchanged. No adapter, mapping step, or write path may alter it. The only normalization anywhere remains a single outer `.trim()`.
- `editTask` is the ONLY function that may write `tasks.title`. It must never be reachable from an MCP tool or a REST route.
- No fuzzy or AI matching in any duplicate decision. Every check is an exact comparison.
- Nothing writes to `tasks` until the batch state is `CONFIRMED`. `importBatch` must refuse any other state.
- Duplicate precedence is fixed: (1) `import_audit` IMPORTED for `(source_type, source_record_id)`, (2) `tasks.source_external_id` match, (3) exact title + same Space + same active status → **NEEDS_REVIEW**, never an auto-skip.
- Derived idempotency key when a source has no record id: `sha256(source_type|title|source_space|source_created_at)`, hex. Never title alone.
- Daily Anchors (Meditate, Exercise, Journal, Cold Exposure, Vocal Warm-Ups) are `INVALID` on exact title match, reason "tracked externally".
- Import writes happen inside one `db.transaction`; a failure leaves zero tasks written.
- Read-back verification compares `title` byte-exact before a batch may report success.
- Rollback hard-deletes only that batch's tasks, refuses tasks touched by a non-import actor unless `force: true`, and never deletes `import_audit` rows.
- `trigger_id` expires 3 seconds after Slack sends it — `views.open` runs before any slow work.
- Slack file uploads are validated server-side regardless of `filetypes`; 10 MB and 20,000 row caps enforced before parsing.
- Statuses remain exactly `open` | `waiting` | `completed`.

---

### Task 1: Transactions in `packages/db`

**Files:**
- Modify: `packages/db/src/client.ts`
- Test: `packages/db/src/transaction.test.ts`

**Interfaces:**
- Consumes: existing `Db`
- Produces: `Db.transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>` — the callback receives a `Db` pinned to one connection, so `task-core` functions work unchanged inside it. Nested calls reuse the same transaction. `tx.close()` is a no-op.

Why this is Task 1: `Db` currently exposes `query`/`exec` over a **pool**, so consecutive calls can land on different connections and `BEGIN`/`COMMIT` would not bracket anything. Every "failed import writes nothing" guarantee depends on this existing first.

- [ ] **Step 1: Write the failing test**

`packages/db/src/transaction.test.ts`:
```ts
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
  expect(await count()).toBe(0); // not 2, and not 1
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/db/src/transaction.test.ts`
Expected: FAIL — `db.transaction is not a function`

- [ ] **Step 3: Implement**

Replace `packages/db/src/client.ts` with:
```ts
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
   * Runs `fn` inside one transaction on a single pinned connection, so
   * BEGIN/COMMIT actually bracket the work. Without this, a pooled `query`
   * can land on a different connection than the BEGIN that preceded it.
   * A throw rolls everything back. Nested calls join the same transaction.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createDb(url = process.env.DATABASE_URL): Promise<Db> {
  if (url && /^postgres(ql)?:\/\//.test(url)) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url });
    const db: Db = {
      async query(sql, params) {
        const r = await pool.query(sql, params as never[]);
        return { rows: r.rows as never[] };
      },
      async exec(sql) { await pool.query(sql); },
      async transaction(fn) {
        const client = await pool.connect();
        const tx: Db = {
          async query(sql, params) {
            const r = await client.query(sql, params as never[]);
            return { rows: r.rows as never[] };
          },
          async exec(sql) { await client.query(sql); },
          transaction: (inner) => inner(tx), // already in a transaction
          async close() { /* no-op: the outer transaction owns the client */ },
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
    return db;
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const pglite = url && url !== 'memory://' ? new PGlite(url) : new PGlite();
  const db: Db = {
    async query(sql, params) {
      const r = await pglite.query(sql, params as unknown[]);
      return { rows: r.rows as never[] };
    },
    async exec(sql) { await pglite.exec(sql); },
    async transaction(fn) {
      return pglite.transaction(async (t) => {
        const tx: Db = {
          async query(sql, params) {
            const r = await t.query(sql, params as unknown[]);
            return { rows: r.rows as never[] };
          },
          async exec(sql) { await t.exec(sql); },
          transaction: (inner) => inner(tx),
          async close() { /* no-op */ },
        };
        return fn(tx);
      }) as Promise<T>;
    },
    close: () => pglite.close(),
  };
  return db;
}
```

Note the `as Promise<T>` on the PGlite branch: its `transaction` returns
`Promise<T | undefined>` because a rollback resolves undefined, but a rollback
here always throws first, so the cast is sound.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/db/src/transaction.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Confirm nothing else broke**

Run: `pnpm test && pnpm typecheck`
Expected: all existing tests pass; typecheck clean

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/client.ts packages/db/src/transaction.test.ts
git commit -m "feat(db): real transaction support on a pinned connection"
```

---

### Task 2: Schema for imports and the `edited` audit event

**Files:**
- Create: `packages/db/migrations/007_imports_and_editing.sql`
- Modify: `packages/db/src/migrate.test.ts` (table list)
- Test: `packages/db/src/imports-schema.test.ts`

**Interfaces:**
- Consumes: `createTestDb` (Task 1)
- Produces: tables `import_batches`, `import_staging`, `import_audit`; columns `tasks.source_external_id`, `tasks.import_batch_id`; `task_events.event` accepts `'edited'`

- [ ] **Step 1: Write the migration**

`packages/db/migrations/007_imports_and_editing.sql`:
```sql
-- Editing a task is a distinct audit event from the deterministic transitions.
ALTER TABLE task_events DROP CONSTRAINT task_events_event_check;
ALTER TABLE task_events ADD CONSTRAINT task_events_event_check
  CHECK (event IN ('created','completed','reopened','moved','details','edited'));

-- Idempotency key for imports, and the batch tag rollback needs.
ALTER TABLE tasks ADD COLUMN source_external_id text;
ALTER TABLE tasks ADD COLUMN import_batch_id uuid;

-- The strongest idempotency guarantee available: a given source record can
-- exist at most once per platform. Partial so ordinary Slack tasks are exempt.
CREATE UNIQUE INDEX tasks_source_external_id_key
  ON tasks (source_platform, source_external_id)
  WHERE source_external_id IS NOT NULL;
CREATE INDEX tasks_import_batch_idx ON tasks (import_batch_id)
  WHERE import_batch_id IS NOT NULL;

CREATE TABLE import_batches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type    text NOT NULL CHECK (source_type IN ('csv','json','workast','kanban')),
  filename       text,
  state          text NOT NULL DEFAULT 'PARSED'
                 CHECK (state IN ('PARSED','MAPPED','ANALYZED','CONFIRMED','IMPORTED','ROLLED_BACK','ABORTED')),
  mapping        jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_count      integer NOT NULL DEFAULT 0,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  confirmed_by   text,
  confirmed_at   timestamptz,
  imported_at    timestamptz,
  rolled_back_at timestamptz,
  CONSTRAINT confirmed_fields_together CHECK (
    (confirmed_at IS NULL AND confirmed_by IS NULL) OR
    (confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)
  )
);

CREATE TABLE import_staging (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id            uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number          integer NOT NULL,
  source_type         text NOT NULL,
  source_record_id    text,
  -- Source bytes, never rewritten by mapping or import.
  title               text NOT NULL,
  space               text,
  list_state          text,
  assignee            text,
  due_at              text,
  waiting_on          text,
  created_at          text,
  completed_at        text,
  status              text,
  source_metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Resolved by the mapping step.
  resolved_space_id   uuid REFERENCES spaces(id),
  resolved_assignee_id text,
  resolved_status     text CHECK (resolved_status IN ('open','waiting','completed')),
  resolved_due_at     timestamptz,
  resolved_created_at timestamptz,
  resolved_completed_at timestamptz,
  idempotency_key     text,
  -- Assigned by the analyze step.
  verdict             text CHECK (verdict IN ('READY','SKIP_DUPLICATE','NEEDS_REVIEW','INVALID')),
  reason              text,
  duplicate_task_id   uuid REFERENCES tasks(id),
  canonical_task_id   uuid REFERENCES tasks(id),
  UNIQUE (batch_id, row_number)
);
CREATE INDEX import_staging_batch_verdict_idx ON import_staging (batch_id, verdict);

CREATE TABLE import_audit (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  source_type       text NOT NULL,
  source_record_id  text,
  canonical_task_id uuid,
  action            text NOT NULL
                    CHECK (action IN ('IMPORTED','SKIPPED_DUPLICATE','NEEDS_REVIEW','FAILED','ROLLED_BACK')),
  reason            text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_audit_batch_idx ON import_audit (batch_id, action);
CREATE INDEX import_audit_source_idx ON import_audit (source_type, source_record_id, action);
```

`import_audit.canonical_task_id` deliberately has **no** foreign key: rollback
hard-deletes tasks, and the audit row must survive to record that it happened.

- [ ] **Step 2: Write the failing test**

`packages/db/src/imports-schema.test.ts`:
```ts
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
  // A different platform with the same id is a different record.
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

it('accepts the edited task event', async () => {
  const { rows: t } = await db.query<{ id: string }>(
    `INSERT INTO tasks (title, space_id) VALUES ('T', $1) RETURNING id`, [spaceId]
  );
  await expect(db.query(
    `INSERT INTO task_events (task_id, event, source) VALUES ($1,'edited','slack')`, [t[0]!.id]
  )).resolves.toBeTruthy();
});
```

- [ ] **Step 3: Update the migration table list**

In `packages/db/src/migrate.test.ts`, the expected table array becomes:
```ts
    expect(rows.map((r) => r.table_name)).toEqual([
      'channel_space_map', 'import_audit', 'import_batches', 'import_staging',
      'lists', 'processed_interactions', 'schema_migrations', 'slack_cards',
      'space_aliases', 'spaces', 'task_events', 'tasks',
    ]);
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/db`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): import batch, staging, and audit schema"
```

---

> **Density note.** Tasks 1-2 and the risky logic in Tasks 3, 6, 7, 8 carry full
> code because being wrong there corrupts task data. Tasks with a settled shape
> (adapters, CLI, read-only tools) carry exact interfaces, the exact assertions
> they must satisfy, and code only where the design is non-obvious. Every task
> still names its files, its interface, and its tests — nothing is left to taste.

---

### Task 3: `editTask` — the single title write path

**Files:**
- Modify: `packages/task-core/src/tasks.ts`, `packages/task-core/src/index.ts`
- Modify: `tests/determinism.test.ts` (the guarantee changes shape)
- Test: `packages/task-core/src/edit.test.ts`

**Interfaces:**
- Consumes: `Db`, `Task`, `TaskStatus`, `Actor`, `assertTaskId`
- Produces:
```ts
export interface EditableFields {
  title?: string;
  spaceId?: string;
  status?: TaskStatus;
  waitingOn?: string | null;
  assigneeId?: string | null;
  dueAt?: Date | null;
  details?: string | null;
}
export async function editTask(
  db: Db, id: string, patch: EditableFields, actor: Actor
): Promise<Task>
```

- [ ] **Step 1: Write the failing test**

`packages/task-core/src/edit.test.ts` must assert:

1. Title is written **byte-exact**, including `’`, `—`, emoji, and `* _ ~` chars.
2. An empty or whitespace-only title throws and writes nothing.
3. A submit whose values all equal current state writes no row and logs **no**
   `edited` event (this is the "unchanged modal submit" case).
4. One `edited` event per call, with a `detail` diff naming only changed fields.
5. `status: 'completed'` sets `completed_at` from the **database** clock;
   leaving completed clears it; re-completing preserves the original stamp.
6. `waiting_on` is cleared automatically when status is not `waiting`.
7. `assigneeId: null` and `dueAt: null` and `details: null` each clear.
8. An invalid `dueAt` (`new Date('nope')`) throws `InvalidDueDateError`.
9. A malformed id throws `InvalidTaskIdError` before any SQL.
10. Keys outside `EditableFields` on the patch object are ignored — pass
    `{ createdAt: new Date(0), sourcePlatform: 'x', id: 'y' } as never` and
    assert those columns are unchanged.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/task-core/src/edit.test.ts`
Expected: FAIL — `editTask` is not exported

- [ ] **Step 3: Implement**

Append to `packages/task-core/src/tasks.ts`:
```ts
export interface EditableFields {
  title?: string;
  spaceId?: string;
  status?: TaskStatus;
  waitingOn?: string | null;
  assigneeId?: string | null;
  dueAt?: Date | null;
  details?: string | null;
}

const EDITABLE_KEYS = [
  'title', 'spaceId', 'status', 'waitingOn', 'assigneeId', 'dueAt', 'details',
] as const;

/**
 * The ONLY function in this system that writes `tasks.title`.
 *
 * Reachable from human surfaces only — the Slack edit modal and (Phase 2B) the
 * web UI. It is deliberately absent from the MCP tool list and the REST routes,
 * so Hermes remains structurally unable to rename, combine, or split a task.
 * `tests/determinism.test.ts` asserts that, not this comment.
 *
 * Reads only EDITABLE_KEYS off `patch`; any other key is ignored because it is
 * never looked at.
 */
export async function editTask(
  db: Db, id: string, patch: EditableFields, actor: Actor
): Promise<Task> {
  const safe = assertTaskId(id);
  const before = await requireTask(db, safe);

  if (patch.title !== undefined) {
    if (typeof patch.title !== 'string' || patch.title.trim().length === 0) {
      throw new Error('title must be a non-empty string');
    }
  }
  if (patch.dueAt != null && Number.isNaN(patch.dueAt.getTime())) {
    throw new InvalidDueDateError(patch.dueAt);
  }
  if (patch.status !== undefined &&
      !['open', 'waiting', 'completed'].includes(patch.status)) {
    throw new Error(`invalid status: ${String(patch.status)}`);
  }

  // Outer trim is the single permitted normalization, exactly as at capture.
  const nextTitle = patch.title !== undefined ? patch.title.trim() : before.title;
  const nextSpace = patch.spaceId ?? before.space_id;
  const nextStatus = patch.status ?? before.status;
  const nextAssignee =
    patch.assigneeId !== undefined ? patch.assigneeId : before.assignee_id;
  const nextDue = patch.dueAt !== undefined ? patch.dueAt : before.due_at;
  const nextDetails =
    patch.details !== undefined
      ? (patch.details === null || patch.details.length === 0 ? null : patch.details)
      : before.details;
  const nextWaitingOn =
    nextStatus === 'waiting'
      ? (patch.waitingOn !== undefined ? patch.waitingOn : before.waiting_on)
      : null;

  const changed: Record<string, { from: unknown; to: unknown }> = {};
  const note = (key: string, from: unknown, to: unknown) => {
    const same = from instanceof Date && to instanceof Date
      ? from.getTime() === to.getTime()
      : from === to;
    if (!same) changed[key] = { from, to };
  };
  note('title', before.title, nextTitle);
  note('space_id', before.space_id, nextSpace);
  note('status', before.status, nextStatus);
  note('assignee_id', before.assignee_id ?? null, nextAssignee ?? null);
  note('due_at', before.due_at ?? null, nextDue ?? null);
  note('waiting_on', before.waiting_on ?? null, nextWaitingOn);
  note('details', before.details ?? null, nextDetails);

  // Nothing changed: no write, no audit event.
  if (Object.keys(changed).length === 0) return before;

  await db.query(
    `UPDATE tasks
        SET title = $2, space_id = $3, status = $4, assignee_id = $5,
            due_at = $6, waiting_on = $7, details = $8,
            completed_at = CASE WHEN $4 = 'completed'
                                THEN COALESCE(completed_at, now()) ELSE NULL END
      WHERE id = $1`,
    [safe, nextTitle, nextSpace, nextStatus, nextAssignee ?? null,
     nextDue ?? null, nextWaitingOn, nextDetails]
  );

  await logEvent(db, safe, 'edited', actor, { changed });
  return requireTask(db, safe);
}
```

Export it from `packages/task-core/src/index.ts` alongside the other mutations.

- [ ] **Step 4: Reshape the determinism guard**

The old assertion ("no title-mutating SQL anywhere") is now false by design.
Replace it in `tests/determinism.test.ts` with three stronger, specific ones:

```ts
it('has exactly one title write path, in task-core', async () => {
  const offenders = (await allSources())
    .filter(({ text }) => /UPDATE\s+tasks[\s\S]*?\btitle\b\s*=/i.test(text))
    .map(({ file }) => file);
  expect(offenders).toEqual(['packages/task-core/src/tasks.ts']);
});

it('never exposes editTask through the Hermes surfaces', async () => {
  const mcp = await readFile('packages/mcp/src/tools.ts', 'utf8');
  const rest = await readFile('apps/api/src/server.ts', 'utf8');
  for (const [name, text] of [['mcp', mcp], ['rest', rest]] as const) {
    expect(text.includes('editTask'), `${name} must not reference editTask`).toBe(false);
  }
  const { TOOL_NAMES } = await import('../packages/mcp/src/tools.js');
  expect(TOOL_NAMES.some((n: string) => /title|rename|edit/i.test(n))).toBe(false);
});

it('keeps editTask reachable only from human Slack and web surfaces', async () => {
  const callers = (await allSources())
    .filter(({ text }) => /\beditTask\s*\(/.test(text))
    .map(({ file }) => file)
    .sort();
  // task-core defines it; the Slack modal submit handler is its only caller
  // until the web UI lands in Phase 2B.
  expect(callers).toEqual([
    'apps/slack/src/handlers/edit-modal.ts',
    'packages/task-core/src/tasks.ts',
  ]);
});
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/task-core tests/determinism.test.ts`
Expected: the third guard FAILS until Task 4 creates `edit-modal.ts` — that is
intended and is the signal to proceed. The first two must pass now.

- [ ] **Step 6: Commit**

```bash
git add packages/task-core tests/determinism.test.ts
git commit -m "feat(core): editTask, the single title write path"
```

---

### Task 4: Slack edit modal — all fields, native elements

**Files:**
- Create: `apps/slack/src/handlers/edit-modal.ts`, `packages/slack-ui/src/edit-view.ts`
- Modify: `packages/slack-ui/src/card.ts` (overflow gains an Edit item), `packages/slack-ui/src/index.ts`, `apps/slack/src/index.ts`
- Test: `packages/slack-ui/src/edit-view.test.ts`, `apps/slack/src/handlers/edit-modal.test.ts`

**Interfaces:**
- Consumes: `editTask`, `listSpaces`, `getTask`, `authorize`, `withCardLock`, `redrawCard`
- Produces:
  - `EDIT_ACTION_ID = 'task_edit'`, `EDIT_CALLBACK_ID = 'task_edit_modal'`
  - `editTaskView(task: Task, spaces: Space[], meta: EditMeta, opts: MetaOpts): View` where `EditMeta = { taskId: string; channelId: string; messageTs: string }`
  - `parseEditSubmission(view: Record<string, any>): { meta: EditMeta; patch: EditableFields }`
  - `handleEditOpen(deps, body): Promise<{ opened: boolean; reason?: string }>`
  - `handleEditSubmission(deps, body): Promise<{ outcome: 'saved' | 'unchanged' | 'unauthorized' | 'invalid' }>`

**Native elements only.** Block ids are fixed constants so `parseEditSubmission`
can read `view.state.values` deterministically:

| Field | `block_id` | `action_id` | Element |
|---|---|---|---|
| Title | `edit_title` | `title` | `plain_text_input`, `initial_value`, `max_length: 3000` |
| Space | `edit_space` | `space` | `static_select`, `initial_option` |
| Status | `edit_status` | `status` | `radio_buttons`, 3 options, `initial_option` |
| Assignee | `edit_assignee` | `assignee` | `users_select`, `optional: true`, `initial_user` when set |
| Due | `edit_due` | `due` | `datetimepicker`, `optional: true`, `initial_date_time` (unix seconds) |
| Waiting on | `edit_waiting_on` | `waiting_on` | `plain_text_input`, `optional: true` |
| Details | `edit_details` | `details` | `plain_text_input`, `multiline: true`, `optional: true` |

- [ ] **Step 1: Write the failing view test**

`packages/slack-ui/src/edit-view.test.ts` must assert:

1. Every editable field sits in a block of `type: 'input'` — because Slack
   documents that **only input blocks appear in `view_submission` state values**,
   so a field in a section accessory would silently never arrive.
2. `callback_id` is `EDIT_CALLBACK_ID` and `private_metadata` round-trips
   `{taskId, channelId, messageTs}` through `JSON.parse`.
3. Title `initial_value` is the current title byte-exact.
4. Status uses `radio_buttons` with exactly 3 options and an `initial_option`
   matching current status **by object identity** with its entry in `options`
   (the same trap as `initial_options` on the card).
5. Assignee omits `initial_user` when unassigned and sets it when assigned.
6. Due omits `initial_date_time` when null; sets unix **seconds** (not ms) when
   set.
7. Optional blocks carry `optional: true`; title and space and status do not.
8. No `button` anywhere in the view except Slack's own submit/close.

- [ ] **Step 2: Write the failing submission test**

`apps/slack/src/handlers/edit-modal.test.ts` must assert:

1. `handleEditOpen` calls `client.views.open` with the payload's `trigger_id`.
2. **Ordering:** `views.open` is called before any task write and the handler
   performs its two reads via one `Promise.all` — assert `views.open` was called
   and that no `chat.update` preceded it. `trigger_id` expires in 3 seconds, so
   slow work before the open is a real failure mode.
3. An unauthorized user gets no `views.open` at all.
4. `parseEditSubmission` maps every field correctly, including: blank title →
   invalid; blank optional inputs → `null` (clear); `datetimepicker` seconds →
   a `Date`; `users_select` empty → `null`.
5. A submission identical to current state returns `unchanged`, writes nothing,
   and logs no `edited` event.
6. A submission changing the title writes it **byte-exact** and redraws the
   originating card in place with the new title.
7. Changing status to `completed` renders the card checked with strikethrough.
8. A blank title returns `invalid` and the handler acks with
   `response_action: 'errors'` keyed on `edit_title` — not a thrown error.
9. The redraw goes through `withCardLock`, so a modal submit cannot interleave
   with a concurrent checkbox toggle on the same card.

- [ ] **Step 3: Implement the view builder**

`packages/slack-ui/src/edit-view.ts`. Build the status option array **once** and
reference the same object in `initial_option`:
```ts
const statusOptions = STATUSES.map((s) => ({
  text: { type: 'plain_text' as const, text: STATUS_LABELS[s] },
  value: s,
}));
const initialStatus = statusOptions.find((o) => o.value === task.status)!;
// initial_option must be that same object, not a structural copy.
```
Due date uses `Math.floor(task.due_at.getTime() / 1000)` for
`initial_date_time`. Assignee sets `initial_user` only when `task.assignee_id`
is non-null.

- [ ] **Step 4: Implement the handlers**

`apps/slack/src/handlers/edit-modal.ts`:
```ts
export async function handleEditOpen(deps, body) {
  const auth = authorize(body, deps.config);
  if (!auth.ok) return { opened: false, reason: auth.reason };

  const raw: string = body.actions?.[0]?.selected_option?.value ?? '';
  const taskId = raw.startsWith('edit:') ? raw.slice('edit:'.length) : '';
  if (!taskId) return { opened: false, reason: 'no_task' };

  // trigger_id expires in 3 seconds: two indexed reads in parallel, then open.
  const [task, spaces] = await Promise.all([
    getTask(deps.db, taskId).catch(() => null),
    listSpaces(deps.db),
  ]);
  if (!task) return { opened: false, reason: 'not_found' };

  await deps.client.views.open({
    trigger_id: body.trigger_id,
    view: editTaskView(task, spaces, {
      taskId,
      channelId: body.container?.channel_id ?? body.channel?.id ?? '',
      messageTs: body.container?.message_ts ?? '',
    }, { timeZone: deps.config.timeZone, assigneeLabels: deps.config.assigneeLabels }),
  });
  return { opened: true };
}
```
`handleEditSubmission` authorizes, parses, returns `invalid` for a blank title
(the Bolt wiring turns that into `ack({response_action:'errors', errors:{edit_title: '...'}})`),
otherwise calls `editTask` and then redraws inside
`withCardLock(`${channelId}:${messageTs}`, ...)`.

- [ ] **Step 5: Add the overflow item**

In `packages/slack-ui/src/card.ts`, `taskControlBlocks` gains a second option:
`{ text: 'Edit task…', value: \`edit:${entry.task.id}\` }`. Completed cards
still return `[]` — that card stays checkbox-only, as specified.

- [ ] **Step 6: Wire Bolt**

In `apps/slack/src/index.ts`:
```ts
app.action(EDIT_ACTION_ID, async ({ ack, body, client }) => {
  await ack();
  await handleEditOpen({ db, client: client as never, config }, body as never);
});

app.view(EDIT_CALLBACK_ID, async ({ ack, body, client, view }) => {
  const result = await handleEditSubmission(
    { db, client: client as never, config }, { ...body, view } as never
  );
  if (result.outcome === 'invalid') {
    await ack({ response_action: 'errors', errors: { edit_title: 'Title cannot be empty.' } });
    return;
  }
  await ack();
});
```
Note the overflow now emits two different action values, so
`handleWaitingAction` must ignore a value starting with `edit:` and
`handleEditOpen` must ignore `waiting:`/`open:` — both already key off their
prefix, and a test asserts each ignores the other's values.

- [ ] **Step 7: Run tests**

Run: `pnpm vitest run packages/slack-ui apps/slack tests/determinism.test.ts`
Expected: PASS, including the Task 3 guard that required `edit-modal.ts` to exist

- [ ] **Step 8: Commit**

```bash
git add packages/slack-ui apps/slack tests/determinism.test.ts
git commit -m "feat(slack): native full-field edit modal"
```

---

### Task 5: Native Slack elements pass over the existing surfaces

**Files:**
- Modify: `packages/slack-ui/src/label.ts`, `packages/slack-ui/src/card.ts`, `packages/slack-ui/src/index.ts`
- Modify: `apps/slack/src/handlers/tasks-command.ts`
- Test: `packages/slack-ui/src/native.test.ts`

Phase 1 hand-rolled four things Slack provides natively. Verified against the Block Kit reference:

| Hand-rolled today | Native replacement | Why the native one is better |
|---|---|---|
| `section` with `*MY TASKS*` / `*MARKETING*` mrkdwn | **`header` block** | a real heading style, not bold text pretending to be one |
| Count lines joined with newlines | **`section.fields`** | Slack lays fields out in two columns itself |
| Dates formatted server-side with luxon in one configured zone | **date token** `<!date^ts^{date_short}|fallback>` | renders in each viewer's own timezone, which server formatting cannot do |
| Assignee from a `DEFAULT_ASSIGNEE_LABEL` env map | **`<@U012AB3CD>`** mention | Slack renders the person's current display name and avatar; no config, never stale |
| No confirmation on any destructive action | **`confirm` object** | native confirm dialog, used by the rollback action |

**The constraint that shapes all of this:** a checkbox `option.description` is
`plain_text` only, confirmed in `@slack/types` as `description?: PlainTextElement`.
Neither the date token nor a user mention renders inside plain_text; both would
show as literal source. So:

- The checkbox meta line KEEPS luxon formatting and the label map. That is now
  documented as a platform constraint rather than a preference, and
  `DEFAULT_ASSIGNEE_LABEL` is demoted to a fallback for this one spot.
- Every mrkdwn surface (context blocks, section text, headings, waiting view)
  uses the native tokens.

**Two places where the more-native option is deliberately rejected**, recorded so
a later reader does not "fix" them:

- **`rich_text_input` for the modal's Details field.** It returns a rich-text
  structure, not a string. `details` holds imported source text that must
  round-trip byte-exact, which a structural round-trip would not. Keep
  `plain_text_input` with `multiline: true`.
- **mrkdwn for the truncated-title context block.** Its purpose is showing the
  exact title literally; mrkdwn would interpret asterisks and underscores.
  Keep `plain_text`.

- [ ] **Step 1: Write the failing test**

`packages/slack-ui/src/native.test.ts` must assert:

1. `slackDate(new Date('2026-09-15T05:00:00Z'), '{date_short}')` returns a string
   of the exact form `<!date^SECONDS^{date_short}|FALLBACK>` where SECONDS is
   unix seconds (not milliseconds) and FALLBACK is non-empty.
2. `slackUser('U_JOSH')` returns `<@U_JOSH>`; `slackUser(null)` returns null.
3. `taskListBlocks` with a heading emits a block of `type: 'header'` whose text
   is `plain_text`, and emits no section whose text is the heading wrapped in
   asterisks.
4. `summaryBlocks(counts)` emits a `header` block plus a section carrying a
   `fields` array, one field per space, and no newline-joined count string.
5. A completed card's mrkdwn context surface contains `<!date^`.
6. The checkbox `description` contains neither `<!date^` nor `<@` — proving the
   plain_text constraint is respected rather than accidentally violated.
7. A list view context line renders an assigned task with `<@U_JOSH>` and an
   unassigned one with no mention and no dangling separator.
8. `confirmObject(title, text)` returns an object with `title`, `text`,
   `confirm`, `deny`, and `style: 'danger'`, each text object `plain_text`.

- [ ] **Step 2: Implement the native helpers**

Add to `packages/slack-ui/src/label.ts`:

```ts
/**
 * Slack's native date token. Renders in the VIEWER's timezone, which
 * server-side formatting cannot do. Valid only in mrkdwn contexts: a
 * plain_text field shows this literally, so never use it in option.description.
 */
export function slackDate(d: Date, token = '{date_short}', timeZone = 'UTC'): string {
  const seconds = Math.floor(d.getTime() / 1000);
  const fallback = DateTime.fromJSDate(d, { zone: timeZone }).toFormat('LLL d, yyyy');
  return `<!date^${seconds}^${token}|${fallback}>`;
}

/** Native user mention. mrkdwn only, same constraint as slackDate. */
export function slackUser(userId: string | null | undefined): string | null {
  return userId ? `<@${userId}>` : null;
}
```

Add to `packages/slack-ui/src/card.ts`:

```ts
export function confirmObject(title: string, text: string) {
  return {
    title: { type: 'plain_text' as const, text: title.slice(0, 100) },
    text: { type: 'plain_text' as const, text: text.slice(0, 300) },
    confirm: { type: 'plain_text' as const, text: 'Yes, do it' },
    deny: { type: 'plain_text' as const, text: 'Cancel' },
    style: 'danger' as const,
  };
}

/** Native heading, not bold text in a section. plain_text, capped at 150. */
export function headerBlock(text: string): KnownBlock {
  return {
    type: 'header',
    text: { type: 'plain_text', text: text.slice(0, 150), emoji: true },
  } as unknown as KnownBlock;
}
```

`taskListBlocks` replaces its section-plus-asterisks heading with `headerBlock`.
A new `summaryBlocks` builder returns `headerBlock('MY TASKS')` plus sections
whose `fields` arrays hold one mrkdwn entry per space, chunked 10 per section
because `fields` caps at 10. Context lines use `slackDate` and `slackUser`. The
`metaLine` description path is untouched.

- [ ] **Step 3: Point `/tasks` at the native builders**

In `apps/slack/src/handlers/tasks-command.ts` the summary branch calls
`summaryBlocks(counts)` instead of assembling a heading string, passing the
plain equivalent as the `text` fallback for notifications. `postList` hands its
heading to `taskListBlocks`, which now emits a `header`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/slack-ui apps/slack`
Expected: PASS. Existing `/tasks` tests assert on stringified output containing
space names and titles, which native blocks still contain; any assertion that
matched the literal bold heading is updated to match the `header` block.

- [ ] **Step 5: Commit**

```bash
git add packages/slack-ui apps/slack
git commit -m "refactor(slack-ui): native header, fields, date tokens, and mentions"
```

---

### Task 6: Adapters, CSV and JSON

**Files:**
- Create: `packages/importer/package.json`, `tsconfig.json`, `src/types.ts`, `src/limits.ts`, `src/errors.ts`, `src/adapters/csv.ts`, `src/adapters/json.ts`, `src/adapters/index.ts`
- Test: `packages/importer/src/adapters/csv.test.ts`, `json.test.ts`, `packages/importer/src/limits.test.ts`

**Interfaces:**
- Produces:

```ts
export type ImportSourceType = 'csv' | 'json' | 'workast' | 'kanban';
export type Verdict = 'READY' | 'SKIP_DUPLICATE' | 'NEEDS_REVIEW' | 'INVALID';
export type BatchState =
  | 'PARSED' | 'MAPPED' | 'ANALYZED' | 'CONFIRMED' | 'IMPORTED'
  | 'ROLLED_BACK' | 'ABORTED';
export type AuditAction =
  | 'IMPORTED' | 'SKIPPED_DUPLICATE' | 'NEEDS_REVIEW' | 'FAILED' | 'ROLLED_BACK';

export interface StagingRow {
  rowNumber: number;
  sourceType: ImportSourceType;
  sourceRecordId: string | null;
  title: string;                       // source bytes, never rewritten
  space: string | null;
  listState: string | null;
  assignee: string | null;
  dueAt: string | null;
  waitingOn: string | null;
  createdAt: string | null;
  completedAt: string | null;
  status: string | null;
  sourceMetadata: Record<string, unknown>;
}

export type Adapter = (input: string) => StagingRow[];
export class ImportParseError extends Error {
  constructor(message: string, readonly rowNumber?: number);
}
export const MAX_FILE_BYTES: number;   // 10 MiB
export const MAX_ROWS: number;         // 20000
export function assertWithinLimits(input: string, sourceType: ImportSourceType): void;
export function sniffFormat(input: string): 'csv' | 'json' | 'unknown';
export function sanitizeForCsvExport(cell: string): string;
```

- [ ] **Step 1: Write the failing tests**

Covers brief tests 8, 9, 10, 11. Assertions:

1. A valid CSV with headers `source_record_id,title,space,status,assignee,due_at,completed_at,waiting_on,list_state`
   parses to the right row count with values in the right fields.
2. Title is byte-exact for: a quoted title containing a comma; a title
   containing a curly apostrophe and an em dash; a title whose inner spaces are
   preserved inside quotes; a title containing a doubled quote escape.
3. Unknown extra columns land in `sourceMetadata` rather than being dropped.
4. Missing optional columns become null, not empty string.
5. A row with an empty title still parses. The adapter stages; the analyze step
   decides validity.
6. Malformed CSV such as an unterminated quote throws `ImportParseError` with a
   row number and stages nothing.
7. Valid JSON parses from a top-level array and from an object with a `tasks` or
   `records` array.
8. JSON that is neither array nor object throws `ImportParseError`.
9. `sniffFormat` returns json for content whose first non-space char is a brace
   or bracket, csv for a comma-bearing first line, unknown for binary-looking
   input.
10. `assertWithinLimits` throws above 10 MiB and above 20000 rows, and the row
    check happens before full parsing: a 25000-line input throws with a
    row-limit message.
11. `sanitizeForCsvExport` prefixes a single quote for values starting with
    equals, plus, minus, at, tab, or carriage return, and leaves ordinary values
    unchanged.
12. A file declared csv whose content sniffs as json is rejected, satisfying the
    brief's file-type validation control.

- [ ] **Step 2: Implement**

Add `csv-parse` as the only new dependency: `pnpm add -F @tr/importer csv-parse`.
Use its sync API with `columns: true`, `relax_column_count: false`,
`skip_empty_lines: true`, mapping known columns onto `StagingRow` and spreading
the remainder into `sourceMetadata`. Wrap its throws in `ImportParseError`.

The JSON adapter accepts an array or an object with `tasks` or `records`,
coerces each field with a string-or-null guard, and never stringifies a
non-string title. A non-string title stages as empty so analysis marks it
INVALID rather than the adapter inventing text.

- [ ] **Step 3: Run tests, then commit**

Run: `pnpm vitest run packages/importer`

```bash
git add packages/importer package.json pnpm-lock.yaml
git commit -m "feat(importer): CSV and JSON adapters with byte-exact titles"
```

---

### Task 7: Staging, mapping, duplicate analysis

**Files:**
- Create: `packages/importer/src/batches.ts`, `src/mapping.ts`, `src/analyze.ts`, `src/keys.ts`, `src/anchors.ts`
- Test: `packages/importer/src/mapping.test.ts`, `analyze.test.ts`, `keys.test.ts`

**Interfaces:**
- Consumes: `Db`, `findSpaceExact`, `StagingRow`, `Verdict`
- Produces:

```ts
export interface ImportMapping {
  spaces?: Record<string, string>;
  assignees?: Record<string, string>;
  statuses?: Record<string, TaskStatus>;
  lists?: Record<string, string>;
  defaultSpace?: string | null;
}
export async function createBatch(db: Db, args: {
  sourceType: ImportSourceType; filename?: string | null; createdBy?: string | null;
}): Promise<string>;
export async function stageRows(db: Db, batchId: string, rows: StagingRow[]): Promise<number>;
export async function applyMapping(db: Db, batchId: string, mapping: ImportMapping): Promise<void>;
export async function analyzeBatch(db: Db, batchId: string): Promise<Record<Verdict, number>>;
export async function getBatch(db: Db, batchId: string): Promise<ImportBatch | null>;
export async function listBatches(db: Db, limit?: number): Promise<ImportBatch[]>;
export async function getStagedRows(db: Db, batchId: string, verdict?: Verdict): Promise<StagedRow[]>;
export function derivedIdempotencyKey(row: StagingRow): string;
export const DAILY_ANCHORS: readonly string[];
export function isDailyAnchor(title: string): boolean;
```

- [ ] **Step 1: Write the failing tests**

`keys.test.ts`:
1. The key is 64 lowercase hex characters.
2. It is stable across calls for identical input, which is what makes a re-run
   idempotent.
3. It changes when title, space, source type, or created-at changes.
4. Two rows sharing a title but differing in source space produce different
   keys, proving it is never title alone.

`mapping.test.ts`, covering brief test 12:
1. A source category maps to a Space id, and the canonical name, slug,
   client-prefix-free name, and configured alias forms all resolve.
2. An unmapped category leaves the resolved space null rather than guessing.
3. `defaultSpace` fills only rows with no source space and never overrides one.
4. An assignee mapping resolves to a Slack id; an unmapped assignee resolves
   null.
5. A status mapping resolves; an unmapped status resolves null.
6. Mapping never writes the staged title: assert byte-identical before and
   after `applyMapping`.
7. An ISO date resolves; a date plus a separate timezone value in
   `sourceMetadata` resolves against that zone; an unparseable date leaves the
   resolved column null.
8. Batch state advances from PARSED to MAPPED.

`analyze.test.ts`, covering brief tests 13, 14, 15, 16, 25:
1. A row whose source type and record id already have an IMPORTED audit row is
   SKIP_DUPLICATE.
2. A row whose record id matches an existing task's `source_external_id` is
   SKIP_DUPLICATE.
3. Exact title plus same resolved Space plus same active status as an existing
   task is NEEDS_REVIEW with `duplicate_task_id` set, and no merge occurs.
4. The same title in a different Space is READY.
5. The same title in the same Space where the existing task is completed and the
   row is open is READY, because the active status differs.
6. A row matching both rule 1 and rule 3 gets SKIP_DUPLICATE, proving the fixed
   precedence.
7. An empty or whitespace-only title is INVALID with a reason naming the title.
8. An unresolved space is INVALID with a reason naming the space.
9. Each Daily Anchor title, matched exactly, is INVALID with reason
   `tracked externally`; a title that merely contains an anchor word is not
   excluded.
10. Returned verdict counts match the staged rows.
11. Re-running `analyzeBatch` is idempotent: same verdicts, no extra rows.
12. Batch state advances from MAPPED to ANALYZED.
13. No source file in the package contains a similarity, Levenshtein, trigram,
    or other fuzzy match call, asserted by grep in the same style as
    `tests/determinism.test.ts`.

- [ ] **Step 2: Implement**

`keys.ts`:

```ts
import { createHash } from 'node:crypto';

/**
 * Used only when a source provides no record id. Deterministic and stable
 * across re-runs of the same file. Never title alone, which would collapse two
 * genuinely different tasks that happen to share a title.
 */
export function derivedIdempotencyKey(row: StagingRow): string {
  return createHash('sha256')
    .update([row.sourceType, row.title, row.space ?? '', row.createdAt ?? ''].join(' '))
    .digest('hex');
}
```

The NUL separator matters: a printable separator would let different field
splits collide.

`analyze.ts` applies the checks in the fixed Global Constraints order, writing
verdict, reason, and duplicate task id per row, then advances batch state. Every
comparison is SQL equality. The package contains no LIKE, no similarity
function, and no distance function.

- [ ] **Step 3: Run tests, then commit**

```bash
git add packages/importer
git commit -m "feat(importer): staging, deterministic mapping, ordered duplicate analysis"
```

---

### Task 8: Confirm, import, read-back verification, audit

**Files:**
- Create: `packages/importer/src/confirm.ts`, `src/import.ts`, `src/audit.ts`, `src/index.ts`
- Test: `packages/importer/src/import.test.ts`

**Interfaces:**
- Consumes: `Db.transaction` from Task 1, `createTask`, `getTask`
- Produces:

```ts
export async function confirmBatch(
  db: Db, batchId: string, actor: { id: string | null }
): Promise<void>;

export interface ImportReport {
  batchId: string;
  imported: number; skipped: number; needsReview: number; failed: number;
  records: Array<{
    sourceRecordId: string | null;
    canonicalTaskId: string | null;
    action: AuditAction;
    reason: string | null;
  }>;
  importedAt: string;
}
export async function importBatch(db: Db, batchId: string): Promise<ImportReport>;
export async function verifyBatch(db: Db, batchId: string): Promise<{ verified: number; failed: string[] }>;
export async function getAudit(db: Db, batchId: string): Promise<AuditRow[]>;
export async function getConflicts(db: Db, batchId: string): Promise<StagedRow[]>;
```

- [ ] **Step 1: Write the failing tests**

Covers brief tests 17, 18, 19, 20, 22:

1. `importBatch` on an ANALYZED but unconfirmed batch throws and writes zero
   tasks. Explicit confirmation is a state-machine property, not a convention.
2. `confirmBatch` requires an actor id, sets confirmed-by and confirmed-at
   together, and moves state to CONFIRMED.
3. `confirmBatch` on an already IMPORTED batch throws.
4. After import only READY rows become tasks; SKIP_DUPLICATE, NEEDS_REVIEW, and
   INVALID rows create none.
5. Each imported title is byte-exact against the staged title, including a
   curly apostrophe, an em dash, and an emoji title.
6. Each imported task carries source platform, `source_external_id`, and
   `import_batch_id`.
7. Read-back verification actually compares: after a successful import, mutate
   one task's title directly by SQL, then assert `verifyBatch` reports that row
   as failed rather than passing.
8. Exactly one `import_audit` row per staged row, with the correct action, and
   `canonical_task_id` set only for IMPORTED.
9. Re-running the same file as a fresh batch imports zero and audits every row
   SKIPPED_DUPLICATE, which is brief test 14 end to end.
10. Transactional failure: stage a row whose resolved space id points at a
    deleted space so the insert violates the foreign key, then assert the task
    count is unchanged from before the call and the batch is not IMPORTED.
11. A completed historical row preserves both source `completed_at` and source
    `created_at` and is not reopened, which is brief test 22.
12. Report counts match the audit rows exactly.

- [ ] **Step 2: Implement**

`import.ts` wraps the whole write in `db.transaction`, iterates READY rows in
`row_number` order, calls `createTask` per row with the batch's source type as
`sourcePlatform`, then sets `source_external_id`, `import_batch_id`, and the
historical `created_at` and `completed_at` with one follow-up UPDATE per row
inside the same transaction.

`createTask` does not accept those columns, so that UPDATE is a deliberate and
documented exception to "adapters never issue task SQL": it writes only import
provenance and historical timestamps, and never `title`. A test asserts the
statement's SET list contains no `title`.

After COMMIT, `verifyBatch` re-reads every imported id and compares title
byte-exact plus space, status, completed-at, due-at, and external id. A mismatch
marks the row FAILED and the report reflects it. Success is never reported on an
unverified write.

- [ ] **Step 3: Run tests, then commit**

```bash
git add packages/importer
git commit -m "feat(importer): confirm gate, transactional import, read-back verification"
```

---

### Task 9: Rollback

**Files:**
- Create: `packages/importer/src/rollback.ts`
- Test: `packages/importer/src/rollback.test.ts`

**Interfaces:**

```ts
export interface RollbackResult {
  batchId: string;
  deleted: number;
  refused: number;
  refusedTaskIds: string[];
}
export async function rollbackBatch(
  db: Db, batchId: string, opts?: { force?: boolean }
): Promise<RollbackResult>;
```

- [ ] **Step 1: Write the failing tests**

Covers brief test 21:

1. Deletes exactly the tasks carrying that `import_batch_id` and nothing else:
   seed two batches plus a hand-created Slack task and assert only batch A's
   tasks disappear.
2. A task with a `task_events` row from a non-import actor is refused, listed in
   `refusedTaskIds`, and still present afterwards.
3. `force: true` deletes a refused task.
4. `import_audit` rows are never deleted, and each affected row gains a
   ROLLED_BACK entry.
5. `task_events` for deleted tasks are removed in the same transaction, leaving
   no foreign-key violation and no orphans.
6. Batch state becomes ROLLED_BACK with `rolled_back_at` set.
7. Rolling back a batch that is not IMPORTED throws.
8. Rolling back twice is safe: the second call deletes zero and does not throw.
9. A `slack_cards` row still listing a deleted task id does not break: assert
   `loadCard` still returns and that filtering yields only surviving tasks,
   which the Phase 1 null-skip already handles.
10. A forced failure inside the transaction leaves every task intact.

- [ ] **Step 2: Implement**

One `db.transaction`. Select candidate ids by `import_batch_id`, partition by
whether any `task_events` row has a source other than the import, delete events
then tasks for the permitted set, append ROLLED_BACK audit rows, and update the
batch. Hard delete is the chosen behavior, recorded in the spec.

- [ ] **Step 3: Run tests, then commit**

```bash
git add packages/importer
git commit -m "feat(importer): guarded hard-delete rollback per batch"
```

---

### Task 10: Workast and Kanban adapters

**Files:**
- Create: `packages/importer/src/adapters/workast.ts`, `src/adapters/kanban.ts`
- Create: `packages/importer/fixtures/kanban-manifest.example.json`
- Test: `packages/importer/src/adapters/workast.test.ts`, `kanban.test.ts`

**Interfaces:** both conform to `Adapter`.

- [ ] **Step 1: Write the failing tests**

`workast.test.ts`, brief test 24, runs against the real export already committed
at `docs/workast-export-2026-09-09.json`:

1. Parses exactly 21 rows.
2. `sourceRecordId` is the Workast task id for every row.
3. All 21 titles are byte-exact against the file, including the two carrying a
   curly apostrophe and the one carrying an em dash.
4. The seven categories land in `space`, and `Personal tasks` and `Music`
   arrive unmapped, because mapping is the caller's job and not the adapter's.
5. The single waiting row maps to a waiting status with a null waiting-on, which
   is what the export contains.
6. The single dated row carries its date, its time, and `America/Chicago` into
   `sourceMetadata`, so mapping can resolve a real timestamp instead of
   flattening to midnight.
7. `details`, up to 3224 characters, is preserved verbatim in `sourceMetadata`.
8. The seven unassigned rows arrive as null, not empty string.
9. `workast_url` and `canonical_source_id` survive in `sourceMetadata`.

`kanban.test.ts`, brief test 23, runs against the committed example manifest,
which is itself the documented schema:

1. `sourceRecordId` is the Kanban task id, preserved exactly.
2. Title byte-exact.
3. Client or category maps to space; assignee, due or review date, waiting
   state, and open or completed state each map to the right field.
4. A manifest missing a required top-level key throws `ImportParseError`.
5. The adapter is pure: assert the file imports no network or filesystem module,
   so importing cannot touch the old Kanban.

- [ ] **Step 2: Implement and record status**

The Workast adapter is verified against real data. The Kanban adapter is written
against `fixtures/kanban-manifest.example.json`, and `MIGRATION_PLAN.md` records
it as awaiting a real manifest, because no sample exists and synthetic fixtures
cannot prove field-name agreement.

- [ ] **Step 3: Run tests, then commit**

```bash
git add packages/importer docs
git commit -m "feat(importer): Workast adapter on real export, Kanban adapter on documented schema"
```

---

### Task 11: Slack-native import wizard

**Files:**
- Create: `apps/slack/src/handlers/import-wizard.ts`, `packages/slack-ui/src/import-views.ts`
- Modify: `apps/slack/src/index.ts`, `SLACK_SETUP.md`
- Test: `packages/slack-ui/src/import-views.test.ts`, `apps/slack/src/handlers/import-wizard.test.ts`

**Interfaces:** `IMPORT_CALLBACK_UPLOAD`, `IMPORT_CALLBACK_MAPPING`,
`IMPORT_CALLBACK_PREVIEW`, `uploadView()`, `mappingView()`, `previewView()`,
`handleImportCommand()`, `handleUploadSubmission()`, `handleMappingSubmission()`,
`handlePreviewSubmission()`, `fetchSlackFile()`.

One native mechanism per brief step:

| Brief step | Native mechanism |
|---|---|
| 1 Upload | `file_input` in an `input` block, `filetypes: ['csv','json']`, `max_files: 1` |
| 2 Parse | server side on submit; nothing written to `tasks` |
| 3 Field mapping | `views.push`, one `static_select` per unmapped source category |
| 4 and 5 Analysis and preview | `views.push`, `header` plus `section.fields` counts plus the exact rows |
| 6 Confirmation | that view's submit, carrying a native `confirm` object |
| Abandonment | `notify_on_close: true`, so `view_closed` marks the batch ABORTED |

- [ ] **Step 1: Write the failing tests**

1. The import command opens the upload view inside the trigger window: assert
   `views.open` is called before any database write.
2. The upload view's element is `file_input`, inside a block of `type: 'input'`,
   with `filetypes: ['csv','json']` and `max_files: 1`.
3. `fetchSlackFile` requests `url_private_download` with the bot token and
   rejects a response whose content length exceeds `MAX_FILE_BYTES` before
   buffering the whole body.
4. Server-side validation runs regardless of `filetypes`: a file named csv whose
   bytes sniff as json is rejected with `response_action: 'errors'`.
5. Upload submission stages a batch and responds with
   `response_action: 'push'` carrying the mapping view, and writes no task.
6. The mapping view lists exactly the unmapped source categories, each with a
   `static_select` of canonical Spaces, and contains no free-text space field.
7. Mapping submission applies the mapping, runs analysis, and pushes the preview
   view with counts per verdict.
8. The preview view's submit carries a native `confirm` object naming the exact
   number of tasks that will be created.
9. Only after preview submission do tasks exist.
10. The view stack never exceeds three, matching Slack's documented limit; any
    further step uses `views.update` rather than a fourth push.
11. `view_closed` on an unconfirmed batch marks it ABORTED, and an aborted batch
    cannot later be imported.
12. An unauthorized user receives no view at any step.

- [ ] **Step 2: Implement, then update `SLACK_SETUP.md`**

Scopes become `commands`, `chat:write`, and `files:read`. Record the reason:
reading an uploaded file's bytes from `url_private_download` requires it.

- [ ] **Step 3: Run tests, then commit**

```bash
git add apps/slack packages/slack-ui SLACK_SETUP.md
git commit -m "feat(slack): native import wizard with file_input and views.push"
```

---

### Task 12: CLI, Hermes read tools, reporting queries

**Files:**
- Create: `scripts/import.ts`, `packages/task-core/src/reports.ts`
- Modify: `packages/mcp/src/tools.ts`, `apps/api/src/server.ts`, `package.json`
- Test: `packages/task-core/src/reports.test.ts`, `packages/mcp/src/import-tools.test.ts`, `tests/cli.test.ts`

**Interfaces:** CLI
`pnpm import-tasks -- --file <path> --type <csv|json|workast|kanban> [--map <json>] [--confirm] [--rollback <batchId>] [--force]`;
MCP tools `list_import_batches`, `get_import_batch`, `preview_import`,
`get_import_conflicts`; reporting functions `openCountBySpace`,
`completedBetween`, `createdThisWeek`, `completedThisWeek`,
`averageTaskAgeDays`, `staleTasks`.

The CLI script name avoids `import`, which is a reserved word in some shells and
collides with pnpm's own `import` command, exactly the class of bug the
`pnpm prune` collision was.

- [ ] **Step 1: Write the failing tests**

Reporting: each function returns correct counts against a seeded fixture; date
ranges are half-open from inclusive to exclusive; average age excludes completed
tasks; stale tasks takes a day threshold and excludes waiting and completed.

MCP: the four tools appear in `TOOL_NAMES`, bringing the total to sixteen; all
four are reads, asserted by seeding a CONFIRMED batch, calling every import
tool, and checking the task count is unchanged; `get_import_conflicts` returns
NEEDS_REVIEW and INVALID rows with reasons; `preview_import` accepts a batch id
and not a file; no import tool name matches confirm, import, rollback, or
delete.

CLI: without `--confirm` it prints the preview and writes nothing; with
`--confirm` it imports and prints the batch id; `--rollback` refuses a touched
task without `--force`; no npm script name collides with a pnpm built-in, per
the existing test.

- [ ] **Step 2: Implement, then commit**

```bash
git add packages/task-core packages/mcp apps/api scripts package.json tests
git commit -m "feat: import CLI, Hermes read-only import tools, reporting queries"
```

---

### Task 13: Documentation and full verification

**Files:**
- Create: `IMPORT.md`
- Modify: `README.md`, `ARCHITECTURE.md`, `MCP_CONTRACT.md`, `MIGRATION_PLAN.md`, `SLACK_SETUP.md`, `.env.example`

- [ ] **Step 1: Write `IMPORT.md`** covering the nine-step flow, the CSV and
  JSON column contract, the duplicate precedence rules, the derived idempotency
  key, rollback semantics as guarded hard delete, and the Kanban adapter's
  awaiting-manifest status.

- [ ] **Step 2: Update the rest.** `ARCHITECTURE.md` gains the transaction API,
  the reshaped title guarantee, and the native-elements rationale including the
  two deliberate non-native choices. `MCP_CONTRACT.md` gains the four import
  tools and the reporting queries, restating that Hermes cannot confirm, import,
  roll back, or rename. `SLACK_SETUP.md` gains `files:read` and the wizard.
  `MIGRATION_PLAN.md` marks Workast ready and Kanban blocked.

- [ ] **Step 3: Full verification**

Run: `pnpm test && pnpm typecheck`
Expected: all green; record the counts.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: importer, editing, and native Slack surfaces"
```

---

## Self-Review

**Spec coverage.** Section 2 title guarantee maps to Task 3. Section 3 modal to
Task 4. Section 3a native wizard to Task 11. Section 4 architecture to Tasks 6
through 9. Section 5 data model to Task 2. Section 6 duplicates and idempotency
to Task 7. Section 7 transactions to Task 1. Section 8 read-back to Task 8.
Section 9 rollback to Task 9. Section 10 formats to Tasks 6 and 10. Section 11
security to Tasks 6 and 11. Section 12 Hermes surface and reporting to Task 12.
Section 13 testing to all tasks. Section 14 deferred stays untouched. The
native-elements audit, which the spec did not originally contain, is Task 5.

**Brief test coverage.** Tests 1 through 7 are web UI and are deferred to Phase
2B, named as such. 8 to T6. 9 to T6. 10 to T6. 11 to T6, T8, T10. 12 to T7.
13 to T7. 14 to T7 and T8. 15 to T7. 16 to T7. 17 to T8. 18 to T8. 19 to T8.
20 to T8. 21 to T9. 22 to T8. 23 to T10. 24 to T10. 25 to T7.

**Type consistency.** `StagingRow`, `ImportMapping`, `Verdict`, `BatchState`,
`AuditAction`, `Adapter`, `ImportReport`, `RollbackResult`, `EditableFields`,
and `EditMeta` are each defined once and imported thereafter. `Db.transaction`
from Task 1 is consumed by Tasks 8 and 9. `confirmObject` and `headerBlock` from
Task 5 are consumed by Task 11.

**Known gaps carried deliberately.** The web UI is Phase 2B. The Kanban adapter
is unverified against real data. Personal sub-domain lists are not seeded, so
the `lists` field of `ImportMapping` has no targets yet; it is accepted and
validated, and a test asserts it fails closed rather than silently ignoring a
mapping.
