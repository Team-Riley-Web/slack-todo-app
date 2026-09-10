# Slack-Native Task Manager — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic Slack-native task manager where a native Slack checkbox is the single task-state control, task titles are stored byte-exact, and Hermes reads through a REST/MCP layer that cannot rename tasks.

**Architecture:** `packages/task-core` is the only code that may mutate a task and exposes no title-mutating function. `apps/slack`, `apps/api`, and `packages/mcp` are thin adapters that parse, authorize, call core, and render. `packages/db` provides one `query(sql, params)` interface with two drivers (PGlite for dev/test, `pg.Pool` for Supabase) running identical SQL migrations.

**Tech Stack:** TypeScript (strict, ESM, NodeNext) · Node 24 · pnpm workspaces · Slack Bolt (Socket Mode default) · PGlite / node-postgres · Fastify · @modelcontextprotocol/sdk · luxon · Vitest

**Spec:** `docs/superpowers/specs/2026-09-09-slack-task-manager-design.md`

## Global Constraints

- Task titles are stored byte-exact. The only normalization permitted anywhere is a single outer `.trim()` of the raw slash-command text at the Slack boundary. No other code may alter a title.
- No function named `updateTitle`, `renameTask`, or equivalent may exist in Phase 1, in any package.
- No LLM call, no fuzzy matching, and no title-based lookup in any mutation path. Tasks are resolved by UUID only.
- Checkbox label budget: `option.text` max **75** chars; strikethrough costs 2; so the title label budget is **72** code points + `…`.
- `option.description` is **plain_text only**, max **75** chars. `option.value` max **75** — carries the bare UUID only.
- `initial_options` entries MUST be the same object references as their `options` counterparts (see Task 6).
- All truncation counts **code points** (`[...str]`), never UTF-16 units (`str.slice`).
- Statuses are exactly `open` | `waiting` | `completed`. No other workflow states.
- Completed tasks are retained permanently. Nothing deletes a task in Phase 1.
- `DEFAULT_TIMEZONE` (default `America/Chicago`) resolves all relative due dates.
- Secrets come from env only. `.env.example` contains empty placeholders only.

---

### Task 1: Workspace scaffold and database layer

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.env.example`
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/src/index.ts`, `packages/db/src/client.ts`, `packages/db/src/migrate.ts`, `packages/db/src/testing.ts`
- Create: `packages/db/migrations/001_init.sql`
- Test: `packages/db/src/migrate.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `type Db = { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>; close(): Promise<void> }`; `createDb(url?: string): Promise<Db>`; `migrate(db: Db): Promise<void>`; `createTestDb(): Promise<Db>` (fresh migrated PGlite, used by every later test)

- [ ] **Step 1: Create the workspace root**

`package.json`:
```json
{
  "name": "team-riley-tasks",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.13.1",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b",
    "migrate": "node --experimental-strip-types packages/db/src/cli-migrate.ts",
    "slack": "node --experimental-strip-types apps/slack/src/index.ts",
    "api": "node --experimental-strip-types apps/api/src/index.ts",
    "mcp": "node --experimental-strip-types packages/mcp/src/index.ts"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@types/node": "^22.7.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "declaration": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "verbatimModuleSyntax": false
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{packages,apps,tests}/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 30_000,
  },
});
```

Run: `pnpm install`

- [ ] **Step 2: Write the schema migration**

`packages/db/migrations/001_init.sql`:
```sql
CREATE TABLE spaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  slug       text NOT NULL UNIQUE,
  is_inbox   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lists (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id   uuid NOT NULL REFERENCES spaces(id),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (space_id, name)
);

CREATE TABLE channel_space_map (
  slack_channel_id   text PRIMARY KEY,
  slack_channel_name text,
  space_id           uuid NOT NULL REFERENCES spaces(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title             text NOT NULL,
  space_id          uuid NOT NULL REFERENCES spaces(id),
  list_id           uuid REFERENCES lists(id),
  assignee_id       text,
  status            text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','waiting','completed')),
  due_at            timestamptz,
  waiting_on        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  source_platform   text NOT NULL DEFAULT 'slack',
  source_channel_id text,
  source_message_ts text,
  created_by        text,
  CONSTRAINT completed_at_iff_completed CHECK (
    (status = 'completed' AND completed_at IS NOT NULL) OR
    (status <> 'completed' AND completed_at IS NULL)
  )
);
CREATE INDEX tasks_space_status_idx ON tasks (space_id, status);
CREATE INDEX tasks_status_idx       ON tasks (status);

CREATE TABLE task_events (
  id         bigserial PRIMARY KEY,
  task_id    uuid NOT NULL REFERENCES tasks(id),
  event      text NOT NULL CHECK (event IN ('created','completed','reopened','moved')),
  actor_id   text,
  source     text NOT NULL,
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_events_task_idx ON task_events (task_id, created_at);

CREATE TABLE slack_cards (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id     text NOT NULL,
  message_ts     text NOT NULL,
  task_ids       uuid[] NOT NULL,
  rendered_state jsonb NOT NULL,
  view_scope     text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, message_ts)
);

CREATE TABLE processed_interactions (
  channel_id   text NOT NULL,
  message_ts   text NOT NULL,
  action_ts    text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, message_ts, action_ts)
);
```

The `completed_at_iff_completed` constraint makes "completed with no timestamp" and "open with a completion timestamp" unrepresentable at the database level, rather than relying on application discipline.

- [ ] **Step 3: Write the failing test**

`packages/db/src/migrate.test.ts`:
```ts
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
      'channel_space_map', 'lists', 'processed_interactions',
      'schema_migrations', 'slack_cards', 'spaces', 'task_events', 'tasks',
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
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run packages/db/src/migrate.test.ts`
Expected: FAIL — cannot resolve `./testing.js`

- [ ] **Step 5: Implement the db package**

`packages/db/package.json`:
```json
{
  "name": "@tr/db",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts", "./testing": "./src/testing.ts" },
  "dependencies": {
    "@electric-sql/pglite": "^0.2.12",
    "pg": "^8.13.0"
  },
  "devDependencies": { "@types/pg": "^8.11.10" }
}
```

`packages/db/src/client.ts`:
```ts
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
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
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const pglite = url ? new PGlite(url) : new PGlite();
  return {
    async query(sql, params) {
      const r = await pglite.query(sql, params as unknown[]);
      return { rows: r.rows as never[] };
    },
    close: () => pglite.close(),
  };
}
```

`packages/db/src/migrate.ts`:
```ts
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './client.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(db: Db): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`
  );
  const { rows } = await db.query<{ name: string }>(`SELECT name FROM schema_migrations`);
  const applied = new Set(rows.map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await db.query(sql);
    await db.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
  }
}
```

`packages/db/src/testing.ts`:
```ts
import { createDb, type Db } from './client.js';
import { migrate } from './migrate.js';

/** A fresh in-memory Postgres, migrated. One per test file. */
export async function createTestDb(): Promise<Db> {
  const db = await createDb('memory://');
  await migrate(db);
  return db;
}
```

`packages/db/src/index.ts`:
```ts
export { createDb, type Db } from './client.js';
export { migrate } from './migrate.js';
```

`packages/db/src/cli-migrate.ts`:
```ts
import { createDb } from './client.js';
import { migrate } from './migrate.js';

const db = await createDb();
await migrate(db);
await db.close();
console.log('migrations applied');
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run packages/db/src/migrate.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Write `.env.example` (empty placeholders only)**

```bash
# Slack — new dedicated app, Socket Mode
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
SLACK_SIGNING_SECRET=
SLACK_TEAM_ID=

# Authorization: comma-separated Slack user IDs. Empty = any member of SLACK_TEAM_ID.
AUTHORIZED_SLACK_USER_IDS=

# Default assignee
DEFAULT_ASSIGNEE_SLACK_ID=
DEFAULT_ASSIGNEE_LABEL=

# Database. Empty = ephemeral in-memory PGlite. file://./.pglite for local persistence.
DATABASE_URL=

# Deterministic relative due-date resolution
DEFAULT_TIMEZONE=America/Chicago

# REST API
API_PORT=3030
API_TOKEN=

# Slack transport: socket | http
SLACK_MODE=socket
PORT=3000
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(db): workspace scaffold, schema, and dual-driver query layer"
```

---

### Task 2: Spaces, channel mapping, and seed

**Files:**
- Create: `packages/db/migrations/002_seed_spaces.sql`
- Create: `packages/task-core/package.json`, `packages/task-core/tsconfig.json`, `packages/task-core/src/spaces.ts`, `packages/task-core/src/types.ts`
- Create: `config/channel-map.example.json`
- Test: `packages/task-core/src/spaces.test.ts`

**Interfaces:**
- Consumes: `Db`, `createTestDb` (Task 1)
- Produces: `listSpaces(db): Promise<Space[]>`; `resolveSpaceForChannel(db, channelId): Promise<Space>` (returns the Inbox space when unmapped); `findSpaceByQuery(db, q): Promise<Space | null>`; `type Space = { id: string; name: string; slug: string; is_inbox: boolean }`

- [ ] **Step 1: Write the seed migration**

`packages/db/migrations/002_seed_spaces.sql`:
```sql
INSERT INTO spaces (name, slug, is_inbox) VALUES
  ('Inbox',                       'inbox',                  true),
  ('Agency / Internal',           'agency-internal',        false),
  ('Marketing',                   'marketing',              false),
  ('Sales',                       'sales',                  false),
  ('Personal',                    'personal',               false),
  ('Client - Joy Within Birth',   'joy-within-birth',       false),
  ('Client - Secure Logic',       'secure-logic',           false),
  ('Client - CFC Skincare',       'cfc-skincare',           false),
  ('Client - Nazareth Law',       'nazareth-law',           false),
  ('Client - Milltown Cabinets',  'milltown-cabinets',      false),
  ('Client - Yoga Farm',          'yoga-farm',              false)
ON CONFLICT (name) DO NOTHING;

INSERT INTO lists (space_id, name)
SELECT id, l.name FROM spaces CROSS JOIN (VALUES ('Open'), ('Waiting / Blocked')) AS l(name)
ON CONFLICT (space_id, name) DO NOTHING;
```

Lists are seeded but `tasks.list_id` stays NULL in Phase 1 — `status` is the single source of truth for open/waiting/completed. See spec §5.

- [ ] **Step 2: Write the failing test**

`packages/task-core/src/spaces.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { listSpaces, resolveSpaceForChannel, findSpaceByQuery } from './spaces.js';

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
  await db.query(
    `INSERT INTO channel_space_map (slack_channel_id, slack_channel_name, space_id)
     SELECT 'C_AGENCY', '#agency-ops', id FROM spaces WHERE name = 'Agency / Internal'`
  );
  await db.query(
    `INSERT INTO channel_space_map (slack_channel_id, slack_channel_name, space_id)
     SELECT 'C_JWB', '#client-joy-within-birth', id FROM spaces
      WHERE name = 'Client - Joy Within Birth'`
  );
});
afterAll(async () => { await db.close(); });

it('seeds all eleven spaces', async () => {
  const spaces = await listSpaces(db);
  expect(spaces).toHaveLength(11);
  expect(spaces.map((s) => s.name)).toContain('Client - Yoga Farm');
});

// Required test 2: mapped channel routes to correct Space
it('routes a mapped channel to its space', async () => {
  expect((await resolveSpaceForChannel(db, 'C_AGENCY')).name).toBe('Agency / Internal');
  expect((await resolveSpaceForChannel(db, 'C_JWB')).name).toBe('Client - Joy Within Birth');
});

// Required test 3: unmapped channel handled safely
it('routes an unmapped channel to Inbox rather than failing or guessing', async () => {
  const space = await resolveSpaceForChannel(db, 'C_UNKNOWN');
  expect(space.name).toBe('Inbox');
  expect(space.is_inbox).toBe(true);
});

it('resolves scope queries case-insensitively by slug, name, and prefix', async () => {
  expect((await findSpaceByQuery(db, 'agency'))?.name).toBe('Agency / Internal');
  expect((await findSpaceByQuery(db, 'PERSONAL'))?.name).toBe('Personal');
  expect((await findSpaceByQuery(db, 'joy within'))?.name).toBe('Client - Joy Within Birth');
  expect((await findSpaceByQuery(db, 'nonsense'))).toBeNull();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/task-core/src/spaces.test.ts`
Expected: FAIL — cannot resolve `./spaces.js`

- [ ] **Step 4: Implement**

`packages/task-core/package.json`:
```json
{
  "name": "@tr/task-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@tr/db": "workspace:*", "luxon": "^3.5.0" },
  "devDependencies": { "@types/luxon": "^3.4.2" }
}
```

`packages/task-core/src/types.ts`:
```ts
export type TaskStatus = 'open' | 'waiting' | 'completed';

export interface Space {
  id: string;
  name: string;
  slug: string;
  is_inbox: boolean;
}

export interface Task {
  id: string;
  title: string;
  space_id: string;
  list_id: string | null;
  assignee_id: string | null;
  status: TaskStatus;
  due_at: Date | null;
  waiting_on: string | null;
  created_at: Date;
  completed_at: Date | null;
  source_platform: string;
  source_channel_id: string | null;
  source_message_ts: string | null;
  created_by: string | null;
}
```

`packages/task-core/src/spaces.ts`:
```ts
import type { Db } from '@tr/db';
import type { Space } from './types.js';

const COLS = `id, name, slug, is_inbox`;

export async function listSpaces(db: Db): Promise<Space[]> {
  const { rows } = await db.query<Space>(
    `SELECT ${COLS} FROM spaces ORDER BY is_inbox DESC, name`
  );
  return rows;
}

export async function getInboxSpace(db: Db): Promise<Space> {
  const { rows } = await db.query<Space>(
    `SELECT ${COLS} FROM spaces WHERE is_inbox = true LIMIT 1`
  );
  const inbox = rows[0];
  if (!inbox) throw new Error('No Inbox space seeded; run migrations');
  return inbox;
}

/** Deterministic: channel mapping only. Never infers a space from message text. */
export async function resolveSpaceForChannel(db: Db, channelId: string): Promise<Space> {
  const { rows } = await db.query<Space>(
    `SELECT s.id, s.name, s.slug, s.is_inbox
       FROM channel_space_map m JOIN spaces s ON s.id = m.space_id
      WHERE m.slack_channel_id = $1`,
    [channelId]
  );
  return rows[0] ?? getInboxSpace(db);
}

/** For `/tasks <scope>`. Exact slug, then exact name, then unique prefix/substring. */
export async function findSpaceByQuery(db: Db, q: string): Promise<Space | null> {
  const needle = q.trim().toLowerCase();
  if (!needle) return null;
  const { rows } = await db.query<Space>(
    `SELECT ${COLS} FROM spaces
      WHERE lower(slug) = $1 OR lower(name) = $1
      LIMIT 1`,
    [needle]
  );
  if (rows[0]) return rows[0];
  const { rows: fuzzy } = await db.query<Space>(
    `SELECT ${COLS} FROM spaces
      WHERE lower(name) LIKE '%' || $1 || '%' OR lower(slug) LIKE '%' || $1 || '%'
      ORDER BY length(name) LIMIT 2`,
    [needle]
  );
  return fuzzy.length === 1 ? fuzzy[0]! : (fuzzy[0] ?? null);
}
```

`findSpaceByQuery` is a **read-path** convenience for `/tasks agency`. It is never used to resolve a mutation target — mutations take UUIDs only.

`config/channel-map.example.json`:
```json
{
  "C0000000001": { "name": "#agency-ops",               "space": "Agency / Internal" },
  "C0000000002": { "name": "#client-joy-within-birth",  "space": "Client - Joy Within Birth" },
  "C0000000003": { "name": "#marketing",                "space": "Marketing" },
  "C0000000004": { "name": "#sales",                    "space": "Sales" }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/task-core/src/spaces.test.ts`
Expected: PASS (4 tests, covering required tests 2 and 3)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): seed spaces, deterministic channel to space resolution"
```

---

### Task 3: Capture parsing — exact titles and strict due dates

**Files:**
- Create: `packages/task-core/src/capture.ts`
- Test: `packages/task-core/src/capture.test.ts`

**Interfaces:**
- Consumes: `luxon`
- Produces: `parseCapture(raw: string, opts: { now: Date; timeZone: string }): { title: string; dueAt: Date | null }`

- [ ] **Step 1: Write the failing test**

`packages/task-core/src/capture.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseCapture } from './capture.js';

const now = new Date('2026-09-09T15:00:00Z'); // Wednesday
const opts = { now, timeZone: 'America/Chicago' };

describe('exact title preservation', () => {
  // Required test 1
  it('stores the literal title verbatim', () => {
    const raw = 'Offer Neil Instagram and Facebook package for $100';
    expect(parseCapture(raw, opts).title).toBe(raw);
  });

  it('never rewrites, summarizes, or normalizes', () => {
    for (const raw of [
      'Call Neil',
      'Prepare Joy Within launch checklist',
      'Renew vehicle registration',
      'Consolidate 401(k): move Corebridge to Fidelity',
      'Waiting on Milltown’s reply to the email proposal',
      'Secure Logic — three-month honeymoon check-in with Marty',
      'Give Rachael access to Marty’s photos',
      'fix *urgent* bug_now~ish~ `code`',
      'multiple   internal    spaces',
      'due tomorrow is part of this title',
      'read docs at https://example.com/a_b_c',
    ]) {
      expect(parseCapture(raw, opts).title).toBe(raw);
      expect(parseCapture(raw, opts).dueAt).toBeNull();
    }
  });

  it('trims only outer whitespace, the single permitted normalization', () => {
    expect(parseCapture('  Call Neil  ', opts).title).toBe('Call Neil');
  });
});

describe('strict due: suffix grammar', () => {
  it('parses an ISO date and strips only the token', () => {
    const r = parseCapture('Call Neil due:2026-09-15', opts);
    expect(r.title).toBe('Call Neil');
    expect(r.dueAt?.toISOString()).toBe('2026-09-15T05:00:00.000Z'); // CDT midnight
  });

  it('parses today and tomorrow in the configured zone', () => {
    expect(parseCapture('X due:today', opts).dueAt?.toISOString()).toBe('2026-09-09T05:00:00.000Z');
    expect(parseCapture('X due:tomorrow', opts).dueAt?.toISOString()).toBe('2026-09-10T05:00:00.000Z');
  });

  it('parses a weekday as the next strictly-future occurrence', () => {
    // now is Wednesday 2026-09-09
    expect(parseCapture('X due:fri', opts).dueAt?.toISOString()).toBe('2026-09-11T05:00:00.000Z');
    expect(parseCapture('X due:wed', opts).dueAt?.toISOString()).toBe('2026-09-16T05:00:00.000Z');
  });

  it('is case-insensitive on the token only', () => {
    expect(parseCapture('X DUE:TOMORROW', opts).title).toBe('X');
  });

  it('ignores a due token that is not the final token', () => {
    const raw = 'due:2026-09-15 call Neil';
    expect(parseCapture(raw, opts).title).toBe(raw);
    expect(parseCapture(raw, opts).dueAt).toBeNull();
  });

  it('ignores malformed and out-of-range tokens, keeping them in the title', () => {
    for (const raw of ['X due:9/15', 'X due:next-week', 'X due:', 'X due:2026-13-45', 'Xdue:today']) {
      expect(parseCapture(raw, opts).title).toBe(raw);
      expect(parseCapture(raw, opts).dueAt).toBeNull();
    }
  });

  it('never leaves an empty title', () => {
    expect(parseCapture('due:today', opts).title).toBe('due:today');
    expect(parseCapture('due:today', opts).dueAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/task-core/src/capture.test.ts`
Expected: FAIL — cannot resolve `./capture.js`

- [ ] **Step 3: Implement**

`packages/task-core/src/capture.ts`:
```ts
import { DateTime } from 'luxon';

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** Strict: a `due:` token is recognised only as the final whitespace-delimited token. */
const DUE_RE = new RegExp(
  `\\s+due:(\\d{4}-\\d{2}-\\d{2}|today|tomorrow|${WEEKDAYS.join('|')})$`,
  'i'
);

export interface CaptureOptions { now: Date; timeZone: string }
export interface Capture { title: string; dueAt: Date | null }

export function parseCapture(raw: string, opts: CaptureOptions): Capture {
  const title = raw.trim();
  const match = DUE_RE.exec(title);
  if (!match) return { title, dueAt: null };

  const dueAt = resolveDue(match[1]!.toLowerCase(), opts);
  if (!dueAt) return { title, dueAt: null };

  const stripped = title.slice(0, match.index).trimEnd();
  // A due token must never consume the entire input.
  if (!stripped) return { title, dueAt: null };
  return { title: stripped, dueAt };
}

function resolveDue(token: string, { now, timeZone }: CaptureOptions): Date | null {
  const today = DateTime.fromJSDate(now, { zone: timeZone }).startOf('day');

  if (token === 'today') return today.toJSDate();
  if (token === 'tomorrow') return today.plus({ days: 1 }).toJSDate();

  const weekday = WEEKDAYS.indexOf(token as (typeof WEEKDAYS)[number]);
  if (weekday >= 0) {
    const target = weekday + 1; // luxon: Monday = 1
    const delta = (target - today.weekday + 7) % 7 || 7; // strictly future
    return today.plus({ days: delta }).toJSDate();
  }

  const dt = DateTime.fromISO(token, { zone: timeZone }).startOf('day');
  return dt.isValid ? dt.toJSDate() : null;
}
```

Note `|| 7` on the weekday delta: `due:wed` on a Wednesday means *next* Wednesday, never today. Deterministic and documented rather than ambiguous.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/task-core/src/capture.test.ts`
Expected: PASS (covers required test 1)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): exact-title capture with strict due: suffix grammar"
```

---

### Task 4: Task mutations — the only write path

**Files:**
- Create: `packages/task-core/src/tasks.ts`, `packages/task-core/src/errors.ts`, `packages/task-core/src/index.ts`
- Test: `packages/task-core/src/tasks.test.ts`

**Interfaces:**
- Consumes: `Db`, `Task`, `TaskStatus`, `Space` (Tasks 1–2)
- Produces:
  - `createTask(db, input: CreateTaskInput): Promise<Task>` where `CreateTaskInput = { title: string; spaceId: string; assigneeId?: string | null; dueAt?: Date | null; sourcePlatform?: string; sourceChannelId?: string | null; sourceMessageTs?: string | null; createdBy?: string | null }`
  - `getTask(db, id: string): Promise<Task | null>`
  - `completeTask(db, id: string, actor: Actor): Promise<Task>`
  - `reopenTask(db, id: string, actor: Actor): Promise<Task>`
  - `moveTask(db, id: string, patch: { spaceId?: string; status?: TaskStatus; waitingOn?: string | null }, actor: Actor): Promise<Task>`
  - `type Actor = { id: string | null; source: string }`
  - `class TaskNotFoundError extends Error`, `class InvalidTaskIdError extends Error`

- [ ] **Step 1: Write the failing test**

`packages/task-core/src/tasks.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask, getTask, completeTask, reopenTask, moveTask } from './tasks.js';
import { InvalidTaskIdError, TaskNotFoundError } from './errors.js';

let db: Db;
let spaceId: string;
const actor = { id: 'U_JOSH', source: 'slack' };

beforeEach(async () => {
  db = await createTestDb();
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM spaces WHERE name = 'Agency / Internal'`
  );
  spaceId = rows[0]!.id;
});
afterEach(async () => { await db.close(); });

const make = (title = 'Call Neil') =>
  createTask(db, { title, spaceId, assigneeId: 'U_JOSH', createdBy: 'U_JOSH' });

// Required test 4
it('persists a task with its exact title', async () => {
  const raw = 'Offer Neil Instagram and Facebook package for $100';
  const created = await make(raw);
  const read = await getTask(db, created.id);
  expect(read!.title).toBe(raw);
  expect(read!.status).toBe('open');
  expect(read!.completed_at).toBeNull();
  expect(read!.list_id).toBeNull(); // spec §5: status is the source of truth
});

it('records a created event', async () => {
  const t = await make();
  const { rows } = await db.query<{ event: string }>(
    `SELECT event FROM task_events WHERE task_id = $1`, [t.id]
  );
  expect(rows.map((r) => r.event)).toEqual(['created']);
});

it('completes a task and sets completed_at', async () => {
  const t = await make();
  const done = await completeTask(db, t.id, actor);
  expect(done.status).toBe('completed');
  expect(done.completed_at).toBeInstanceOf(Date);
  expect(done.title).toBe(t.title);
});

// Required test 6
it('is idempotent on repeated completion, with no duplicate events', async () => {
  const t = await make();
  const first = await completeTask(db, t.id, actor);
  const second = await completeTask(db, t.id, actor);
  expect(second.status).toBe('completed');
  expect(second.completed_at!.getTime()).toBe(first.completed_at!.getTime());
  const { rows } = await db.query(
    `SELECT 1 FROM task_events WHERE task_id = $1 AND event = 'completed'`, [t.id]
  );
  expect(rows).toHaveLength(1);
});

it('reopens a completed task and clears completed_at', async () => {
  const t = await make();
  await completeTask(db, t.id, actor);
  const back = await reopenTask(db, t.id, actor);
  expect(back.status).toBe('open');
  expect(back.completed_at).toBeNull();
  expect(back.title).toBe(t.title);
});

it('is idempotent on repeated reopen of an already-open task', async () => {
  const t = await make();
  const a = await reopenTask(db, t.id, actor);
  const b = await reopenTask(db, t.id, actor);
  expect(a.status).toBe('open');
  expect(b.status).toBe('open');
  const { rows } = await db.query(
    `SELECT 1 FROM task_events WHERE task_id = $1 AND event = 'reopened'`, [t.id]
  );
  expect(rows).toHaveLength(0); // no transition occurred, so no event
});

// Required test 11
it('preserves waiting state and waiting_on', async () => {
  const t = await make();
  const w = await moveTask(db, t.id, { status: 'waiting', waitingOn: 'Milltown reply' }, actor);
  expect(w.status).toBe('waiting');
  expect(w.waiting_on).toBe('Milltown reply');
  const read = await getTask(db, t.id);
  expect(read!.status).toBe('waiting');
  expect(read!.waiting_on).toBe('Milltown reply');
});

it('allows waiting with no waiting_on', async () => {
  const t = await make();
  const w = await moveTask(db, t.id, { status: 'waiting' }, actor);
  expect(w.status).toBe('waiting');
  expect(w.waiting_on).toBeNull();
});

it('clears waiting_on when leaving the waiting state', async () => {
  const t = await make();
  await moveTask(db, t.id, { status: 'waiting', waitingOn: 'Milltown' }, actor);
  const back = await moveTask(db, t.id, { status: 'open' }, actor);
  expect(back.waiting_on).toBeNull();
});

it('completing a waiting task works and does not auto-complete on its own', async () => {
  const t = await make();
  await moveTask(db, t.id, { status: 'waiting' }, actor);
  expect((await getTask(db, t.id))!.status).toBe('waiting'); // required test 10 partner
  const done = await completeTask(db, t.id, actor);
  expect(done.status).toBe('completed');
});

// Required test 17
it('rejects a malformed task id before touching the database', async () => {
  for (const bad of ['', 'not-a-uuid', '../../etc/passwd', "'; DROP TABLE tasks; --", '123']) {
    await expect(getTask(db, bad)).rejects.toThrow(InvalidTaskIdError);
    await expect(completeTask(db, bad, actor)).rejects.toThrow(InvalidTaskIdError);
  }
});

it('throws TaskNotFoundError for a well-formed unknown id', async () => {
  await expect(
    completeTask(db, '00000000-0000-4000-8000-000000000000', actor)
  ).rejects.toThrow(TaskNotFoundError);
});

// Required test 18
it('exposes no title-mutating function', async () => {
  const mod = await import('./index.js');
  const names = Object.keys(mod);
  expect(names.some((n) => /title|rename/i.test(n))).toBe(false);
  for (const n of ['updateTitle', 'renameTask', 'setTitle', 'editTitle']) {
    expect(mod).not.toHaveProperty(n);
  }
});

// Required test 15
it('ignores any title field supplied to a mutation', async () => {
  const t = await make('Original exact title');
  await moveTask(
    db, t.id,
    { status: 'waiting', title: 'AI-rewritten title' } as never,
    actor
  );
  expect((await getTask(db, t.id))!.title).toBe('Original exact title');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/task-core/src/tasks.test.ts`
Expected: FAIL — cannot resolve `./tasks.js`

- [ ] **Step 3: Implement errors**

`packages/task-core/src/errors.ts`:
```ts
export class InvalidTaskIdError extends Error {
  constructor(readonly value: string) {
    super(`Invalid task id`);
    this.name = 'InvalidTaskIdError';
  }
}

export class TaskNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Task not found: ${id}`);
    this.name = 'TaskNotFoundError';
  }
}

export class UnauthorizedError extends Error {
  constructor(readonly userId: string | undefined) {
    super('Not authorized');
    this.name = 'UnauthorizedError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Guards every mutation entry point. Rejects before any SQL is issued. */
export function assertTaskId(id: unknown): string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new InvalidTaskIdError(String(id));
  }
  return id;
}
```

- [ ] **Step 4: Implement mutations**

`packages/task-core/src/tasks.ts`:
```ts
import type { Db } from '@tr/db';
import type { Task, TaskStatus } from './types.js';
import { assertTaskId, TaskNotFoundError } from './errors.js';

export interface Actor { id: string | null; source: string }

export interface CreateTaskInput {
  title: string;
  spaceId: string;
  assigneeId?: string | null;
  dueAt?: Date | null;
  sourcePlatform?: string;
  sourceChannelId?: string | null;
  sourceMessageTs?: string | null;
  createdBy?: string | null;
}

const COLS = `id, title, space_id, list_id, assignee_id, status, due_at, waiting_on,
              created_at, completed_at, source_platform, source_channel_id,
              source_message_ts, created_by`;

/**
 * The title is written exactly as given. No trimming, casing, or normalization
 * happens here — the Slack boundary performs the single permitted outer trim.
 */
export async function createTask(db: Db, input: CreateTaskInput): Promise<Task> {
  if (typeof input.title !== 'string' || input.title.length === 0) {
    throw new Error('title is required');
  }
  const { rows } = await db.query<Task>(
    `INSERT INTO tasks (title, space_id, assignee_id, due_at, source_platform,
                        source_channel_id, source_message_ts, created_by)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'slack'), $6, $7, $8)
     RETURNING ${COLS}`,
    [
      input.title, input.spaceId, input.assigneeId ?? null, input.dueAt ?? null,
      input.sourcePlatform ?? null, input.sourceChannelId ?? null,
      input.sourceMessageTs ?? null, input.createdBy ?? null,
    ]
  );
  const task = rows[0]!;
  await logEvent(db, task.id, 'created', {
    id: input.createdBy ?? null,
    source: input.sourcePlatform ?? 'slack',
  });
  return task;
}

export async function getTask(db: Db, id: string): Promise<Task | null> {
  const safe = assertTaskId(id);
  const { rows } = await db.query<Task>(`SELECT ${COLS} FROM tasks WHERE id = $1`, [safe]);
  return rows[0] ?? null;
}

async function requireTask(db: Db, id: string): Promise<Task> {
  const task = await getTask(db, id);
  if (!task) throw new TaskNotFoundError(id);
  return task;
}

/** Idempotent by construction: the UPDATE is a no-op when already completed. */
export async function completeTask(db: Db, id: string, actor: Actor): Promise<Task> {
  const safe = assertTaskId(id);
  await requireTask(db, safe);
  const { rows } = await db.query<{ id: string }>(
    `UPDATE tasks SET status = 'completed', completed_at = now()
      WHERE id = $1 AND status <> 'completed' RETURNING id`,
    [safe]
  );
  if (rows.length > 0) await logEvent(db, safe, 'completed', actor);
  return requireTask(db, safe); // always read back
}

/** Idempotent by construction: the UPDATE is a no-op when already open. */
export async function reopenTask(db: Db, id: string, actor: Actor): Promise<Task> {
  const safe = assertTaskId(id);
  await requireTask(db, safe);
  const { rows } = await db.query<{ id: string }>(
    `UPDATE tasks SET status = 'open', completed_at = NULL
      WHERE id = $1 AND status = 'completed' RETURNING id`,
    [safe]
  );
  if (rows.length > 0) await logEvent(db, safe, 'reopened', actor);
  return requireTask(db, safe);
}

export interface MovePatch {
  spaceId?: string;
  status?: TaskStatus;
  waitingOn?: string | null;
}

/**
 * Moves space and/or status. Deliberately cannot touch `title` — any `title`
 * key on the patch object is ignored because it is never read.
 */
export async function moveTask(
  db: Db, id: string, patch: MovePatch, actor: Actor
): Promise<Task> {
  const safe = assertTaskId(id);
  const before = await requireTask(db, safe);

  const nextStatus = patch.status ?? before.status;
  const nextSpace = patch.spaceId ?? before.space_id;
  const nextWaitingOn =
    nextStatus === 'waiting' ? (patch.waitingOn ?? before.waiting_on ?? null) : null;
  const nextCompletedAt =
    nextStatus === 'completed' ? (before.completed_at ?? new Date()) : null;

  await db.query(
    `UPDATE tasks SET space_id = $2, status = $3, waiting_on = $4, completed_at = $5
      WHERE id = $1`,
    [safe, nextSpace, nextStatus, nextWaitingOn, nextCompletedAt]
  );

  const changed =
    before.status !== nextStatus ||
    before.space_id !== nextSpace ||
    (before.waiting_on ?? null) !== nextWaitingOn;
  if (changed) {
    await logEvent(db, safe, 'moved', actor, {
      from: { status: before.status, space_id: before.space_id },
      to: { status: nextStatus, space_id: nextSpace, waiting_on: nextWaitingOn },
    });
  }
  return requireTask(db, safe);
}

async function logEvent(
  db: Db, taskId: string, event: string, actor: Actor, detail?: unknown
): Promise<void> {
  await db.query(
    `INSERT INTO task_events (task_id, event, actor_id, source, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [taskId, event, actor.id ?? null, actor.source, detail ? JSON.stringify(detail) : null]
  );
}
```

`packages/task-core/src/index.ts`:
```ts
export * from './types.js';
export * from './errors.js';
export { parseCapture, type Capture, type CaptureOptions } from './capture.js';
export {
  listSpaces, getInboxSpace, resolveSpaceForChannel, findSpaceByQuery,
} from './spaces.js';
export {
  createTask, getTask, completeTask, reopenTask, moveTask,
  type Actor, type CreateTaskInput, type MovePatch,
} from './tasks.js';
export {
  listTasks, listWaiting, getTaskCounts, type ListTasksFilter, type SpaceCount,
} from './queries.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/task-core/src/tasks.test.ts`
Expected: PASS (covers required tests 4, 6, 11, 15, 17, 18)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): deterministic task mutations with no title-write path"
```

---

### Task 5: Read queries and counts

**Files:**
- Create: `packages/task-core/src/queries.ts`
- Test: `packages/task-core/src/queries.test.ts`

**Interfaces:**
- Consumes: `Db`, `Task` (Tasks 1, 4)
- Produces:
  - `listTasks(db, filter: ListTasksFilter): Promise<Task[]>` where `ListTasksFilter = { spaceId?: string; status?: TaskStatus | TaskStatus[]; actionableOnly?: boolean; assigneeId?: string; limit?: number }`
  - `listWaiting(db, filter?: { spaceId?: string }): Promise<Task[]>`
  - `getTaskCounts(db, filter?: { assigneeId?: string }): Promise<SpaceCount[]>` where `SpaceCount = { space_id: string; space_name: string; open: number; waiting: number }`

- [ ] **Step 1: Write the failing test**

`packages/task-core/src/queries.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask, completeTask, moveTask } from './tasks.js';
import { listTasks, listWaiting, getTaskCounts } from './queries.js';

let db: Db;
const actor = { id: 'U_JOSH', source: 'test' };
const spaceIds: Record<string, string> = {};

beforeEach(async () => {
  db = await createTestDb();
  const { rows } = await db.query<{ id: string; name: string }>(`SELECT id, name FROM spaces`);
  for (const r of rows) spaceIds[r.name] = r.id;
});
afterEach(async () => { await db.close(); });

const add = (space: string, title: string) =>
  createTask(db, { title, spaceId: spaceIds[space]!, assigneeId: 'U_JOSH' });

// Required tests 9, 10, 12
it('counts only open and waiting, never completed', async () => {
  const a = await add('Agency / Internal', 'A');
  await add('Agency / Internal', 'B');
  const w = await add('Agency / Internal', 'C');
  await add('Marketing', 'D');

  await completeTask(db, a.id, actor);
  await moveTask(db, w.id, { status: 'waiting', waitingOn: 'Neil' }, actor);

  const counts = await getTaskCounts(db);
  const agency = counts.find((c) => c.space_name === 'Agency / Internal')!;
  expect(agency.open).toBe(1);     // B only: A completed, C waiting
  expect(agency.waiting).toBe(1);
  expect(counts.find((c) => c.space_name === 'Marketing')!.open).toBe(1);
  // spaces with nothing actionable are omitted
  expect(counts.find((c) => c.space_name === 'Sales')).toBeUndefined();
});

it('excludes waiting tasks from the actionable list', async () => {
  const w = await add('Agency / Internal', 'Waiting one');
  await add('Agency / Internal', 'Open one');
  await moveTask(db, w.id, { status: 'waiting' }, actor);

  const actionable = await listTasks(db, { actionableOnly: true });
  expect(actionable.map((t) => t.title)).toEqual(['Open one']);
});

it('excludes completed tasks from the actionable list', async () => {
  const c = await add('Marketing', 'Done one');
  await add('Marketing', 'Live one');
  await completeTask(db, c.id, actor);
  const actionable = await listTasks(db, { actionableOnly: true });
  expect(actionable.map((t) => t.title)).toEqual(['Live one']);
});

// Required test 13
it('scopes a list to one space', async () => {
  await add('Agency / Internal', 'Agency task');
  await add('Personal', 'Personal task');
  const scoped = await listTasks(db, {
    spaceId: spaceIds['Personal']!, actionableOnly: true,
  });
  expect(scoped.map((t) => t.title)).toEqual(['Personal task']);
});

it('lists waiting tasks with their waiting_on', async () => {
  const w = await add('Client - Milltown Cabinets', 'Waiting on Milltown’s reply');
  await moveTask(db, w.id, { status: 'waiting', waitingOn: 'email proposal reply' }, actor);
  await add('Marketing', 'Not waiting');
  const waiting = await listWaiting(db);
  expect(waiting).toHaveLength(1);
  expect(waiting[0]!.title).toBe('Waiting on Milltown’s reply');
  expect(waiting[0]!.waiting_on).toBe('email proposal reply');
});

it('orders by due date first, then creation, so undated tasks trail dated ones', async () => {
  await createTask(db, {
    title: 'later', spaceId: spaceIds['Sales']!, dueAt: new Date('2026-12-01T00:00:00Z'),
  });
  await createTask(db, {
    title: 'sooner', spaceId: spaceIds['Sales']!, dueAt: new Date('2026-10-01T00:00:00Z'),
  });
  await createTask(db, { title: 'undated', spaceId: spaceIds['Sales']! });
  const rows = await listTasks(db, { spaceId: spaceIds['Sales']!, actionableOnly: true });
  expect(rows.map((t) => t.title)).toEqual(['sooner', 'later', 'undated']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/task-core/src/queries.test.ts`
Expected: FAIL — cannot resolve `./queries.js`

- [ ] **Step 3: Implement**

`packages/task-core/src/queries.ts`:
```ts
import type { Db } from '@tr/db';
import type { Task, TaskStatus } from './types.js';

const COLS = `id, title, space_id, list_id, assignee_id, status, due_at, waiting_on,
              created_at, completed_at, source_platform, source_channel_id,
              source_message_ts, created_by`;

export interface ListTasksFilter {
  spaceId?: string;
  status?: TaskStatus | TaskStatus[];
  /** open only — excludes both waiting and completed. Daily-priority semantics. */
  actionableOnly?: boolean;
  assigneeId?: string;
  limit?: number;
}

export async function listTasks(db: Db, filter: ListTasksFilter = {}): Promise<Task[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.actionableOnly) {
    where.push(`status = 'open'`);
  } else if (filter.status) {
    const list = Array.isArray(filter.status) ? filter.status : [filter.status];
    params.push(list);
    where.push(`status = ANY($${params.length})`);
  }
  if (filter.spaceId) { params.push(filter.spaceId); where.push(`space_id = $${params.length}`); }
  if (filter.assigneeId) { params.push(filter.assigneeId); where.push(`assignee_id = $${params.length}`); }

  params.push(Math.min(filter.limit ?? 200, 500));
  const { rows } = await db.query<Task>(
    `SELECT ${COLS} FROM tasks
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY due_at ASC NULLS LAST, created_at ASC
      LIMIT $${params.length}`,
    params
  );
  return rows;
}

export function listWaiting(db: Db, filter: { spaceId?: string } = {}): Promise<Task[]> {
  return listTasks(db, { ...filter, status: 'waiting' });
}

export interface SpaceCount {
  space_id: string;
  space_name: string;
  open: number;
  waiting: number;
}

/** Counts exclude completed tasks entirely. Spaces with nothing actionable are omitted. */
export async function getTaskCounts(
  db: Db, filter: { assigneeId?: string } = {}
): Promise<SpaceCount[]> {
  const params: unknown[] = [];
  let assigneeClause = '';
  if (filter.assigneeId) {
    params.push(filter.assigneeId);
    assigneeClause = `AND t.assignee_id = $${params.length}`;
  }
  const { rows } = await db.query<{
    space_id: string; space_name: string; open: string; waiting: string;
  }>(
    `SELECT s.id AS space_id, s.name AS space_name,
            COUNT(*) FILTER (WHERE t.status = 'open')    AS open,
            COUNT(*) FILTER (WHERE t.status = 'waiting') AS waiting
       FROM spaces s
       JOIN tasks t ON t.space_id = s.id AND t.status IN ('open','waiting') ${assigneeClause}
      GROUP BY s.id, s.name
      HAVING COUNT(*) > 0
      ORDER BY s.name`,
    params
  );
  return rows.map((r) => ({
    space_id: r.space_id,
    space_name: r.space_name,
    open: Number(r.open),
    waiting: Number(r.waiting),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/task-core/src/queries.test.ts`
Expected: PASS (covers required tests 9, 10, 12, 13)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): read queries, actionable filtering, and space counts"
```

---

### Task 6: Slack UI renderers — the native checkbox card

**Files:**
- Create: `packages/slack-ui/package.json`, `packages/slack-ui/tsconfig.json`, `packages/slack-ui/src/index.ts`, `packages/slack-ui/src/label.ts`, `packages/slack-ui/src/card.ts`
- Test: `packages/slack-ui/src/label.test.ts`, `packages/slack-ui/src/card.test.ts`

**Interfaces:**
- Consumes: `Task`, `Space` (Task 2), `@slack/types`
- Produces:
  - `truncateLabel(title: string): { label: string; truncated: boolean }`
  - `metaLine(task: Task, space: Space, opts: MetaOpts): string` where `MetaOpts = { assigneeLabels?: Record<string, string>; timeZone: string }`
  - `taskOption(task: Task, space: Space, opts: MetaOpts): Option`
  - `taskCardBlocks(entries: CardEntry[], opts: MetaOpts): KnownBlock[]` where `CardEntry = { task: Task; space: Space }`
  - `taskListBlocks(groups: CardGroup[], opts: MetaOpts): KnownBlock[]` where `CardGroup = { heading: string | null; entries: CardEntry[] }`
  - `CHECKBOX_ACTION_ID = 'task_checkbox'`, `CHECKBOX_BLOCK_PREFIX = 'task_toggle'`, `LABEL_BUDGET = 72`

- [ ] **Step 1: Write the failing label test**

`packages/slack-ui/src/label.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { truncateLabel, metaLine, LABEL_BUDGET } from './label.js';
import type { Task, Space } from '@tr/task-core';

const space = (name: string): Space =>
  ({ id: 's', name, slug: 'x', is_inbox: false });

const task = (over: Partial<Task> = {}): Task => ({
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Call Neil', space_id: 's', list_id: null, assignee_id: null,
  status: 'open', due_at: null, waiting_on: null, created_at: new Date(),
  completed_at: null, source_platform: 'slack', source_channel_id: null,
  source_message_ts: null, created_by: null, ...over,
});

const opts = { timeZone: 'America/Chicago', assigneeLabels: { U_JOSH: 'Joshua' } };

describe('truncateLabel', () => {
  it('leaves a short title untouched', () => {
    expect(truncateLabel('Call Neil')).toEqual({ label: 'Call Neil', truncated: false });
  });

  it('leaves a title of exactly the budget untouched', () => {
    const t = 'x'.repeat(LABEL_BUDGET);
    expect(truncateLabel(t)).toEqual({ label: t, truncated: false });
  });

  it('truncates one char over the budget and flags it', () => {
    const r = truncateLabel('x'.repeat(LABEL_BUDGET + 1));
    expect(r.truncated).toBe(true);
    expect([...r.label]).toHaveLength(LABEL_BUDGET + 1); // 72 + ellipsis
    expect(r.label.endsWith('…')).toBe(true);
  });

  it('keeps the strikethrough form within Slack’s 75-char option cap', () => {
    const r = truncateLabel('y'.repeat(400));
    expect([...`~${r.label}~`]).toHaveLength(75);
  });

  it('counts code points, not UTF-16 units, for astral characters', () => {
    // Each emoji is 1 code point but 2 UTF-16 units. A naive slice would
    // cut 36 emoji and could split a surrogate pair.
    const r = truncateLabel('🙂'.repeat(100));
    expect([...r.label]).toHaveLength(LABEL_BUDGET + 1);
    expect(r.label.slice(0, -1)).toBe('🙂'.repeat(LABEL_BUDGET));
    expect(r.label).not.toContain('�');
    expect(Array.from(r.label).every((c) => c === '🙂' || c === '…')).toBe(true);
  });

  it('preserves the curly apostrophes and em dashes present in real data', () => {
    for (const t of [
      'Waiting on Milltown’s reply to the email proposal',
      'Secure Logic — three-month honeymoon check-in with Marty',
    ]) {
      expect(truncateLabel(t)).toEqual({ label: t, truncated: false });
    }
  });
});

describe('metaLine', () => {
  it('renders space, assignee, and due date for an open task', () => {
    const line = metaLine(
      task({ assignee_id: 'U_JOSH', due_at: new Date('2026-09-15T05:00:00Z') }),
      space('Client - Nazareth Law'), opts
    );
    expect(line).toBe('Nazareth Law · Joshua · due Sep 15');
  });

  it('renders completion for a completed task and drops due/assignee', () => {
    const line = metaLine(
      task({
        status: 'completed', assignee_id: 'U_JOSH',
        completed_at: new Date('2026-09-09T18:00:00Z'),
      }),
      space('Client - Nazareth Law'), opts
    );
    expect(line).toBe('Completed Sep 9 · Nazareth Law');
  });

  it('renders waiting_on when present and bare waiting when not', () => {
    expect(metaLine(task({ status: 'waiting', waiting_on: 'Neil' }), space('Sales'), opts))
      .toBe('Sales · waiting on Neil');
    expect(metaLine(task({ status: 'waiting' }), space('Sales'), opts))
      .toBe('Sales · waiting');
  });

  it('omits an assignee with no configured label rather than showing a raw ID', () => {
    expect(metaLine(task({ assignee_id: 'U_NOBODY' }), space('Sales'), opts)).toBe('Sales');
  });

  it('never exceeds Slack’s 75-char description cap', () => {
    const line = metaLine(
      task({
        status: 'waiting', assignee_id: 'U_JOSH',
        waiting_on: 'a very long explanation '.repeat(10),
      }),
      space('Client - Milltown Cabinets'), opts
    );
    expect([...line].length).toBeLessThanOrEqual(75);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/slack-ui/src/label.test.ts`
Expected: FAIL — cannot resolve `./label.js`

- [ ] **Step 3: Implement labels**

`packages/slack-ui/package.json`:
```json
{
  "name": "@tr/slack-ui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@tr/task-core": "workspace:*",
    "@slack/types": "^2.14.0",
    "luxon": "^3.5.0"
  }
}
```

`packages/slack-ui/src/label.ts`:
```ts
import { DateTime } from 'luxon';
import type { Space, Task } from '@tr/task-core';

/** Slack caps option.text at 75 chars; `~…~` costs 2, leaving 72 for the title. */
export const LABEL_BUDGET = 72;
/** Slack caps option.description at 75 chars. */
export const DESCRIPTION_BUDGET = 75;

export interface MetaOpts {
  timeZone: string;
  assigneeLabels?: Record<string, string>;
}

/**
 * Display-only. Counts code points, never UTF-16 units — `str.slice` can split
 * a surrogate pair and corrupt a character. Never written back to storage.
 */
export function truncateLabel(title: string): { label: string; truncated: boolean } {
  const points = [...title];
  if (points.length <= LABEL_BUDGET) return { label: title, truncated: false };
  return { label: `${points.slice(0, LABEL_BUDGET).join('')}…`, truncated: true };
}

function shortSpace(name: string): string {
  return name.startsWith('Client - ') ? name.slice('Client - '.length) : name;
}

function fmtDate(d: Date, timeZone: string): string {
  return DateTime.fromJSDate(d, { zone: timeZone }).toFormat('LLL d');
}

function clip(text: string, budget: number): string {
  const points = [...text];
  return points.length <= budget ? text : `${points.slice(0, budget - 1).join('')}…`;
}

/**
 * plain_text, max 75. Compaction order when over budget: drop assignee, then
 * abbreviate the space name, then clip. Meta is derived data and is not covered
 * by the exact-title guarantee.
 */
export function metaLine(task: Task, space: Space, opts: MetaOpts): string {
  const assignee = task.assignee_id
    ? opts.assigneeLabels?.[task.assignee_id]
    : undefined;

  const build = (withAssignee: boolean, shortenSpace: boolean): string => {
    const parts: string[] = [];
    if (task.status === 'completed' && task.completed_at) {
      parts.push(`Completed ${fmtDate(task.completed_at, opts.timeZone)}`);
    }
    parts.push(shortenSpace ? shortSpace(space.name) : space.name);
    if (task.status !== 'completed') {
      if (withAssignee && assignee) parts.push(assignee);
      if (task.due_at) parts.push(`due ${fmtDate(task.due_at, opts.timeZone)}`);
      if (task.status === 'waiting') {
        parts.push(task.waiting_on ? `waiting on ${task.waiting_on}` : 'waiting');
      }
    }
    return parts.join(' · ');
  };

  for (const candidate of [build(true, true), build(false, true), build(false, true)]) {
    if ([...candidate].length <= DESCRIPTION_BUDGET) return candidate;
  }
  return clip(build(false, true), DESCRIPTION_BUDGET);
}
```

Note `shortSpace` is applied in all candidates: the mock in the spec shows
`Nazareth Law`, not `Client - Nazareth Law`.

- [ ] **Step 4: Run label test to verify it passes**

Run: `pnpm vitest run packages/slack-ui/src/label.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing card test**

`packages/slack-ui/src/card.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { taskCardBlocks, taskOption, CHECKBOX_ACTION_ID } from './card.js';
import type { Task, Space } from '@tr/task-core';

const space: Space = { id: 's', name: 'Client - Nazareth Law', slug: 'nl', is_inbox: false };
const opts = { timeZone: 'America/Chicago', assigneeLabels: { U_JOSH: 'Joshua' } };

const task = (over: Partial<Task> = {}): Task => ({
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Offer Neil Instagram and Facebook package for $100',
  space_id: 's', list_id: null, assignee_id: 'U_JOSH', status: 'open',
  due_at: null, waiting_on: null, created_at: new Date(), completed_at: null,
  source_platform: 'slack', source_channel_id: null, source_message_ts: null,
  created_by: null, ...over,
});

const checkbox = (blocks: any[]) =>
  blocks.find((b) => b.type === 'actions').elements[0];

describe('open task card', () => {
  it('uses a native checkboxes element inside an actions block', () => {
    const el = checkbox(taskCardBlocks([{ task: task(), space }], opts));
    expect(el.type).toBe('checkboxes');
    expect(el.action_id).toBe(CHECKBOX_ACTION_ID);
    expect(el.options).toHaveLength(1);
  });

  it('renders the title as plain_text so mrkdwn characters stay literal', () => {
    const el = checkbox(taskCardBlocks([{ task: task({ title: 'fix *urgent* bug' }), space }], opts));
    expect(el.options[0].text).toEqual({
      type: 'plain_text', text: 'fix *urgent* bug', emoji: true,
    });
  });

  it('carries the bare task UUID as the option value', () => {
    const el = checkbox(taskCardBlocks([{ task: task(), space }], opts));
    expect(el.options[0].value).toBe('11111111-1111-4111-8111-111111111111');
    expect([...el.options[0].value].length).toBeLessThanOrEqual(75);
  });

  it('omits initial_options entirely when nothing is complete', () => {
    const el = checkbox(taskCardBlocks([{ task: task(), space }], opts));
    expect(el.initial_options).toBeUndefined();
  });

  it('sets a plain_text description with the meta line', () => {
    const el = checkbox(taskCardBlocks([{ task: task(), space }], opts));
    expect(el.options[0].description.type).toBe('plain_text');
    expect(el.options[0].description.text).toBe('Nazareth Law · Joshua');
  });
});

describe('completed task card', () => {
  const done = task({ status: 'completed', completed_at: new Date('2026-09-09T18:00:00Z') });

  it('renders mrkdwn strikethrough with verbatim set', () => {
    const el = checkbox(taskCardBlocks([{ task: done, space }], opts));
    expect(el.options[0].text).toEqual({
      type: 'mrkdwn',
      text: '~Offer Neil Instagram and Facebook package for $100~',
      verbatim: true,
    });
  });

  it('marks the checkbox selected', () => {
    const el = checkbox(taskCardBlocks([{ task: done, space }], opts));
    expect(el.initial_options).toHaveLength(1);
    expect(el.initial_options[0].value).toBe(done.id);
  });

  // The initial_options bug trap — spec §4
  it('places the SAME object reference in options and initial_options', () => {
    const el = checkbox(taskCardBlocks([{ task: done, space }], opts));
    expect(el.initial_options[0]).toBe(el.options[0]);
    expect(el.initial_options[0]).toEqual(el.options[0]);
  });

  it('keeps the checkbox interactive so unchecking can reopen', () => {
    const blocks = taskCardBlocks([{ task: done, space }], opts);
    const el = checkbox(blocks);
    expect(el.action_id).toBe(CHECKBOX_ACTION_ID);
    // no button of any kind, ever
    const buttons = JSON.stringify(blocks).match(/"type":"button"/g);
    expect(buttons).toBeNull();
  });

  it('states completion in the description as a strikethrough-independent signal', () => {
    const el = checkbox(taskCardBlocks([{ task: done, space }], opts));
    expect(el.options[0].description.text).toBe('Completed Sep 9 · Nazareth Law');
  });
});

describe('mixed group', () => {
  const a = task({ id: '11111111-1111-4111-8111-111111111111', title: 'Meditate' });
  const b = task({
    id: '22222222-2222-4222-8222-222222222222', title: 'Exercise',
    status: 'completed', completed_at: new Date('2026-09-09T18:00:00Z'),
  });
  const c = task({ id: '33333333-3333-4333-8333-333333333333', title: 'Journal' });

  it('selects only the completed entries, by reference', () => {
    const el = checkbox(taskCardBlocks(
      [{ task: a, space }, { task: b, space }, { task: c, space }], opts
    ));
    expect(el.options).toHaveLength(3);
    expect(el.initial_options).toHaveLength(1);
    expect(el.initial_options[0]).toBe(el.options[1]);
  });

  it('splits into multiple elements beyond Slack’s 10-option cap', () => {
    const entries = Array.from({ length: 23 }, (_, i) => ({
      task: task({ id: `${i}`.padStart(8, '0') + '-1111-4111-8111-111111111111', title: `T${i}` }),
      space,
    }));
    const blocks = taskCardBlocks(entries, opts);
    const groups = blocks.filter((b: any) => b.type === 'actions');
    expect(groups.map((g: any) => g.elements[0].options.length)).toEqual([10, 10, 3]);
    const ids = new Set(groups.map((g: any) => g.block_id));
    expect(ids.size).toBe(3); // block_ids must be unique within a message
  });
});

describe('truncated title', () => {
  const long = task({ title: 'L'.repeat(200) });

  it('adds a context block carrying the full exact title', () => {
    const blocks = taskCardBlocks([{ task: long, space }], opts);
    const ctx = blocks.find((b: any) => b.type === 'context') as any;
    expect(ctx.elements[0].text).toContain('L'.repeat(200));
  });

  it('does not add a context block when nothing is truncated', () => {
    const blocks = taskCardBlocks([{ task: task(), space }], opts);
    expect(blocks.find((b: any) => b.type === 'context')).toBeUndefined();
  });

  it('never mutates the task title while rendering', () => {
    const t = task({ title: 'M'.repeat(200) });
    const before = t.title;
    taskCardBlocks([{ task: t, space }], opts);
    expect(t.title).toBe(before);
  });
});
```

- [ ] **Step 6: Run card test to verify it fails**

Run: `pnpm vitest run packages/slack-ui/src/card.test.ts`
Expected: FAIL — cannot resolve `./card.js`

- [ ] **Step 7: Implement the card renderer**

`packages/slack-ui/src/card.ts`:
```ts
import type { KnownBlock, Option } from '@slack/types';
import type { Space, Task } from '@tr/task-core';
import { metaLine, truncateLabel, type MetaOpts } from './label.js';

export const CHECKBOX_ACTION_ID = 'task_checkbox';
export const CHECKBOX_BLOCK_PREFIX = 'task_toggle';
/** Slack allows at most 10 options per checkboxes element. */
export const MAX_OPTIONS_PER_ELEMENT = 10;

export interface CardEntry { task: Task; space: Space }
export interface CardGroup { heading: string | null; entries: CardEntry[] }

/**
 * Open  → plain_text, so `* _ ~ \`` stay literal.
 * Done  → mrkdwn (strikethrough requires it) with verbatim, so URLs, @mentions
 *         and #channels in the title are not rewritten into links.
 */
export function taskOption(task: Task, space: Space, opts: MetaOpts): Option {
  const { label } = truncateLabel(task.title);
  const description = metaLine(task, space, opts);

  const text =
    task.status === 'completed'
      ? ({ type: 'mrkdwn', text: `~${label}~`, verbatim: true } as const)
      : ({ type: 'plain_text', text: label, emoji: true } as const);

  const option = { text, value: task.id } as Option;
  if (description.length > 0) {
    (option as { description?: unknown }).description = {
      type: 'plain_text', text: description, emoji: true,
    };
  }
  return option;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function taskCardBlocks(entries: CardEntry[], opts: MetaOpts): KnownBlock[] {
  if (entries.length === 0) return [];
  const blocks: KnownBlock[] = [];

  chunk(entries, MAX_OPTIONS_PER_ELEMENT).forEach((group, groupIndex) => {
    // Build each option exactly once. initial_options must contain the SAME
    // object references, or Slack fails to match them and a completed task
    // renders unchecked. See spec §4.
    const options = group.map((e) => taskOption(e.task, e.space, opts));
    const initial = options.filter((_, i) => group[i]!.task.status === 'completed');

    const element: Record<string, unknown> = {
      type: 'checkboxes',
      action_id: CHECKBOX_ACTION_ID,
      options,
    };
    if (initial.length > 0) element.initial_options = initial;

    blocks.push({
      type: 'actions',
      block_id: `${CHECKBOX_BLOCK_PREFIX}:${groupIndex}`,
      elements: [element],
    } as unknown as KnownBlock);
  });

  // Any title too long for a 75-char option label keeps its exact form here.
  const truncated = entries.filter((e) => truncateLabel(e.task.title).truncated);
  if (truncated.length > 0) {
    blocks.push({
      type: 'context',
      elements: truncated.map((e) => ({
        type: 'plain_text' as const,
        text: `Full title: ${e.task.title}`,
        emoji: true,
      })),
    } as unknown as KnownBlock);
  }

  return blocks;
}

export function taskListBlocks(groups: CardGroup[], opts: MetaOpts): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  for (const group of groups) {
    if (group.entries.length === 0) continue;
    if (group.heading) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${group.heading}*` },
      } as KnownBlock);
    }
    blocks.push(...taskCardBlocks(group.entries, opts));
  }
  return blocks;
}

/** Plain-text fallback used as the message `text` field for notifications. */
export function taskCardFallback(entries: CardEntry[]): string {
  return entries
    .map((e) => (e.task.status === 'completed' ? `[x] ${e.task.title}` : `[ ] ${e.task.title}`))
    .join('\n');
}
```

`packages/slack-ui/src/index.ts`:
```ts
export {
  truncateLabel, metaLine, LABEL_BUDGET, DESCRIPTION_BUDGET, type MetaOpts,
} from './label.js';
export {
  taskOption, taskCardBlocks, taskListBlocks, taskCardFallback,
  CHECKBOX_ACTION_ID, CHECKBOX_BLOCK_PREFIX, MAX_OPTIONS_PER_ELEMENT,
  type CardEntry, type CardGroup,
} from './card.js';
```

- [ ] **Step 8: Run card test to verify it passes**

Run: `pnpm vitest run packages/slack-ui/src/card.test.ts`
Expected: PASS (covers required test 8, plus the §4 identity trap)

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(slack-ui): native checkbox card with code-point-safe labels"
```

---

### Task 7: Checkbox toggle handler — complete and reopen

**Files:**
- Create: `apps/slack/package.json`, `apps/slack/tsconfig.json`, `apps/slack/src/config.ts`, `apps/slack/src/auth.ts`, `apps/slack/src/cards.ts`, `apps/slack/src/handlers/checkbox.ts`
- Test: `apps/slack/src/auth.test.ts`, `apps/slack/src/handlers/checkbox.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6
- Produces:
  - `readSelectedValues(body: BlockActionsBody, blockId: string, actionId: string): string[]`
  - `authorize(body, config): { ok: true; userId: string } | { ok: false; reason: string }`
  - `saveCard(db, { channelId, messageTs, entries, viewScope? }): Promise<void>`
  - `loadCard(db, channelId, messageTs): Promise<{ task_ids: string[]; rendered_state: Record<string, boolean> } | null>`
  - `handleCheckboxToggle(deps, body): Promise<{ outcome: 'applied' | 'noop' | 'duplicate' | 'unauthorized' | 'unknown_card' }>`

- [ ] **Step 1: Write the failing auth test**

`apps/slack/src/auth.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { authorize } from './auth.js';

const base = { team: { id: 'T_RILEY' }, user: { id: 'U_JOSH' } } as never;

it('accepts a workspace member when no allowlist is configured', () => {
  const r = authorize(base, { teamId: 'T_RILEY', authorizedUserIds: [] });
  expect(r).toEqual({ ok: true, userId: 'U_JOSH' });
});

// Required test 16
it('rejects a user from another workspace', () => {
  const r = authorize(
    { team: { id: 'T_OTHER' }, user: { id: 'U_JOSH' } } as never,
    { teamId: 'T_RILEY', authorizedUserIds: [] }
  );
  expect(r.ok).toBe(false);
});

it('rejects a user outside a configured allowlist', () => {
  const r = authorize(base, { teamId: 'T_RILEY', authorizedUserIds: ['U_OTHER'] });
  expect(r.ok).toBe(false);
});

it('accepts a user inside a configured allowlist', () => {
  const r = authorize(base, { teamId: 'T_RILEY', authorizedUserIds: ['U_JOSH', 'U_X'] });
  expect(r).toEqual({ ok: true, userId: 'U_JOSH' });
});

it('rejects a payload with no user id', () => {
  expect(authorize({ team: { id: 'T_RILEY' } } as never,
    { teamId: 'T_RILEY', authorizedUserIds: [] }).ok).toBe(false);
});

it('rejects when enterprise-style team id is absent', () => {
  expect(authorize({ user: { id: 'U_JOSH' } } as never,
    { teamId: 'T_RILEY', authorizedUserIds: [] }).ok).toBe(false);
});
```

- [ ] **Step 2: Implement config and auth**

`apps/slack/package.json`:
```json
{
  "name": "@tr/slack-app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@slack/bolt": "^4.2.0",
    "@tr/db": "workspace:*",
    "@tr/slack-ui": "workspace:*",
    "@tr/task-core": "workspace:*",
    "dotenv": "^16.4.5"
  }
}
```

`apps/slack/src/config.ts`:
```ts
export interface AppConfig {
  teamId: string;
  authorizedUserIds: string[];
  defaultAssigneeId: string | null;
  assigneeLabels: Record<string, string>;
  timeZone: string;
  mode: 'socket' | 'http';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const defaultAssigneeId = env.DEFAULT_ASSIGNEE_SLACK_ID?.trim() || null;
  const assigneeLabels: Record<string, string> = {};
  if (defaultAssigneeId && env.DEFAULT_ASSIGNEE_LABEL?.trim()) {
    assigneeLabels[defaultAssigneeId] = env.DEFAULT_ASSIGNEE_LABEL.trim();
  }
  return {
    teamId: env.SLACK_TEAM_ID?.trim() ?? '',
    authorizedUserIds: (env.AUTHORIZED_SLACK_USER_IDS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    defaultAssigneeId,
    assigneeLabels,
    timeZone: env.DEFAULT_TIMEZONE?.trim() || 'America/Chicago',
    mode: env.SLACK_MODE === 'http' ? 'http' : 'socket',
  };
}
```

`apps/slack/src/auth.ts`:
```ts
export interface AuthConfig { teamId: string; authorizedUserIds: string[] }
export type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; reason: string };

interface AuthLikeBody {
  team?: { id?: string } | null;
  user?: { id?: string } | null;
  is_enterprise_install?: boolean;
}

/** Runs before any database write. A rejection performs zero mutation. */
export function authorize(body: AuthLikeBody, config: AuthConfig): AuthResult {
  const userId = body.user?.id;
  if (!userId) return { ok: false, reason: 'no_user' };

  const teamId = body.team?.id;
  if (config.teamId && teamId !== config.teamId) {
    return { ok: false, reason: 'wrong_workspace' };
  }
  if (!config.teamId) return { ok: false, reason: 'unconfigured_team' };

  if (config.authorizedUserIds.length > 0 && !config.authorizedUserIds.includes(userId)) {
    return { ok: false, reason: 'not_allowlisted' };
  }
  return { ok: true, userId };
}
```

An empty `SLACK_TEAM_ID` fails closed rather than open — a misconfigured deploy rejects everything instead of accepting every workspace.

- [ ] **Step 3: Run auth test to verify it passes**

Run: `pnpm vitest run apps/slack/src/auth.test.ts`
Expected: PASS (covers required test 16)

- [ ] **Step 4: Write the failing checkbox test**

`apps/slack/src/handlers/checkbox.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask, getTask, completeTask } from '@tr/task-core';
import { saveCard } from '../cards.js';
import { handleCheckboxToggle, readSelectedValues } from './checkbox.js';

let db: Db;
let spaceId: string;
let space: any;
const config = {
  teamId: 'T_RILEY', authorizedUserIds: [], defaultAssigneeId: 'U_JOSH',
  assigneeLabels: { U_JOSH: 'Joshua' }, timeZone: 'America/Chicago', mode: 'socket' as const,
};

const client = { chat: { update: vi.fn() } };

beforeEach(async () => {
  db = await createTestDb();
  client.chat.update = vi.fn().mockResolvedValue({ ok: true });
  const { rows } = await db.query<any>(
    `SELECT id, name, slug, is_inbox FROM spaces WHERE name = 'Client - Nazareth Law'`
  );
  space = rows[0]; spaceId = rows[0].id;
});
afterEach(async () => { await db.close(); });

const seed = async (title = 'Offer Neil Instagram and Facebook package for $100') => {
  const task = await createTask(db, { title, spaceId, assigneeId: 'U_JOSH' });
  await saveCard(db, {
    channelId: 'C_NL', messageTs: '1700000000.000100',
    entries: [{ task, space }],
  });
  return task;
};

const payload = (selectedIds: string[], over: Record<string, unknown> = {}) => ({
  type: 'block_actions',
  team: { id: 'T_RILEY' },
  user: { id: 'U_JOSH' },
  channel: { id: 'C_NL' },
  container: { type: 'message', channel_id: 'C_NL', message_ts: '1700000000.000100' },
  actions: [{
    type: 'checkboxes', action_id: 'task_checkbox', block_id: 'task_toggle:0',
    action_ts: '1700000001.000001',
    selected_options: selectedIds.map((id) => ({ value: id })),
  }],
  state: {
    values: {
      'task_toggle:0': {
        task_checkbox: {
          type: 'checkboxes',
          selected_options: selectedIds.map((id) => ({ value: id })),
        },
      },
    },
  },
  ...over,
});

const deps = () => ({ db, client: client as never, config });

describe('readSelectedValues', () => {
  it('reads from state.values, the documented location', () => {
    expect(readSelectedValues(payload(['a']) as never, 'task_toggle:0', 'task_checkbox'))
      .toEqual(['a']);
  });

  it('falls back to action.selected_options when state is absent', () => {
    const p: any = payload(['b']); delete p.state;
    expect(readSelectedValues(p, 'task_toggle:0', 'task_checkbox')).toEqual(['b']);
  });

  it('falls back to action.options, which the docs example shows', () => {
    const p: any = payload([]);
    delete p.state;
    p.actions[0].selected_options = undefined;
    p.actions[0].options = [{ value: 'c' }];
    expect(readSelectedValues(p, 'task_toggle:0', 'task_checkbox')).toEqual(['c']);
  });

  it('treats an empty array as a genuine deselect-all, not missing data', () => {
    expect(readSelectedValues(payload([]) as never, 'task_toggle:0', 'task_checkbox'))
      .toEqual([]);
  });
});

describe('completion via checkbox', () => {
  // Required test 5
  it('completes the exact task identified by the option value', async () => {
    const task = await seed();
    const other = await createTask(db, { title: 'Untouched', spaceId });
    const r = await handleCheckboxToggle(deps(), payload([task.id]) as never);
    expect(r.outcome).toBe('applied');
    expect((await getTask(db, task.id))!.status).toBe('completed');
    expect((await getTask(db, other.id))!.status).toBe('open');
  });

  // Required test 7
  it('updates the same Slack message in place', async () => {
    const task = await seed();
    await handleCheckboxToggle(deps(), payload([task.id]) as never);
    expect(client.chat.update).toHaveBeenCalledTimes(1);
    const arg = client.chat.update.mock.calls[0][0];
    expect(arg.channel).toBe('C_NL');
    expect(arg.ts).toBe('1700000000.000100');
  });

  // Required test 8
  it('renders the completed title with strikethrough and a checked box', async () => {
    const task = await seed();
    await handleCheckboxToggle(deps(), payload([task.id]) as never);
    const el = client.chat.update.mock.calls[0][0].blocks
      .find((b: any) => b.type === 'actions').elements[0];
    expect(el.options[0].text.text)
      .toBe('~Offer Neil Instagram and Facebook package for $100~');
    expect(el.initial_options).toHaveLength(1);
    expect(el.initial_options[0]).toBe(el.options[0]);
  });

  it('posts no additional message', async () => {
    const task = await seed();
    const spy = vi.fn();
    await handleCheckboxToggle(
      { db, client: { chat: { update: client.chat.update, postMessage: spy } } as never, config },
      payload([task.id]) as never
    );
    expect(spy).not.toHaveBeenCalled();
  });

  // Required test 6
  it('is idempotent across a duplicate Slack retry', async () => {
    const task = await seed();
    const p = payload([task.id]);
    await handleCheckboxToggle(deps(), p as never);
    const first = (await getTask(db, task.id))!.completed_at!.getTime();
    const second = await handleCheckboxToggle(deps(), p as never);
    expect(second.outcome).toBe('duplicate');
    expect((await getTask(db, task.id))!.completed_at!.getTime()).toBe(first);
    const { rows } = await db.query(
      `SELECT 1 FROM task_events WHERE task_id = $1 AND event = 'completed'`, [task.id]
    );
    expect(rows).toHaveLength(1);
  });

  it('redraws the completed state on a duplicate rather than silently dropping it', async () => {
    const task = await seed();
    const p = payload([task.id]);
    await handleCheckboxToggle(deps(), p as never);
    await handleCheckboxToggle(deps(), p as never);
    expect(client.chat.update).toHaveBeenCalledTimes(2);
  });
});

describe('reopen via uncheck', () => {
  it('reopens the task and clears completed_at', async () => {
    const task = await seed();
    await completeTask(db, task.id, { id: 'U_JOSH', source: 'test' });
    await saveCard(db, {
      channelId: 'C_NL', messageTs: '1700000000.000100',
      entries: [{ task: (await getTask(db, task.id))!, space }],
    });
    const r = await handleCheckboxToggle(deps(), payload([]) as never);
    expect(r.outcome).toBe('applied');
    const back = (await getTask(db, task.id))!;
    expect(back.status).toBe('open');
    expect(back.completed_at).toBeNull();
    expect(back.title).toBe(task.title);
  });

  it('renders the reopened title without strikethrough and unchecked', async () => {
    const task = await seed();
    await completeTask(db, task.id, { id: 'U_JOSH', source: 'test' });
    await saveCard(db, {
      channelId: 'C_NL', messageTs: '1700000000.000100',
      entries: [{ task: (await getTask(db, task.id))!, space }],
    });
    await handleCheckboxToggle(deps(), payload([]) as never);
    const el = client.chat.update.mock.calls[0][0].blocks
      .find((b: any) => b.type === 'actions').elements[0];
    expect(el.options[0].text.text).toBe(task.title);
    expect(el.options[0].text.type).toBe('plain_text');
    expect(el.initial_options).toBeUndefined();
  });

  it('is a no-op when unchecking an already-open task', async () => {
    const task = await seed();
    const r = await handleCheckboxToggle(deps(), payload([]) as never);
    expect(r.outcome).toBe('noop');
    expect((await getTask(db, task.id))!.status).toBe('open');
    const { rows } = await db.query(
      `SELECT 1 FROM task_events WHERE task_id = $1 AND event = 'reopened'`, [task.id]
    );
    expect(rows).toHaveLength(0);
  });
});

describe('grouped cards', () => {
  it('applies only the toggled task, leaving stale siblings alone', async () => {
    const a = await createTask(db, { title: 'Meditate', spaceId });
    const b = await createTask(db, { title: 'Exercise', spaceId });
    await completeTask(db, b.id, { id: 'U_JOSH', source: 'test' });
    const bDone = (await getTask(db, b.id))!;
    await saveCard(db, {
      channelId: 'C_NL', messageTs: '1700000000.000100',
      entries: [{ task: a, space }, { task: bDone, space }],
    });
    // The user checks A. B stays checked in the payload.
    const r = await handleCheckboxToggle(deps(), payload([a.id, b.id]) as never);
    expect(r.outcome).toBe('applied');
    expect((await getTask(db, a.id))!.status).toBe('completed');
    expect((await getTask(db, b.id))!.completed_at!.getTime())
      .toBe(bDone.completed_at!.getTime()); // untouched, not re-stamped
  });

  it('reopens only the task the user actually unchecked', async () => {
    const a = await createTask(db, { title: 'Meditate', spaceId });
    const b = await createTask(db, { title: 'Exercise', spaceId });
    await completeTask(db, a.id, { id: 'U_JOSH', source: 'test' });
    await completeTask(db, b.id, { id: 'U_JOSH', source: 'test' });
    await saveCard(db, {
      channelId: 'C_NL', messageTs: '1700000000.000100',
      entries: [
        { task: (await getTask(db, a.id))!, space },
        { task: (await getTask(db, b.id))!, space },
      ],
    });
    await handleCheckboxToggle(deps(), payload([b.id]) as never);
    expect((await getTask(db, a.id))!.status).toBe('open');
    expect((await getTask(db, b.id))!.status).toBe('completed');
  });
});

describe('rejections', () => {
  // Required test 16
  it('rejects an unauthorized user with zero mutation', async () => {
    const task = await seed();
    const p = payload([task.id], { team: { id: 'T_INTRUDER' } });
    const r = await handleCheckboxToggle(deps(), p as never);
    expect(r.outcome).toBe('unauthorized');
    expect((await getTask(db, task.id))!.status).toBe('open');
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  // Required tests 17, 18
  it('rejects a malformed task id without mutating anything', async () => {
    await seed();
    const p = payload(["'; DROP TABLE tasks; --"]);
    const r = await handleCheckboxToggle(deps(), p as never);
    expect(r.outcome).toBe('noop');
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM tasks`);
    expect((rows[0] as any).n).toBe(1);
  });

  it('ignores an option value that is not part of the recorded card', async () => {
    const task = await seed();
    const foreign = await createTask(db, { title: 'Not on this card', spaceId });
    await handleCheckboxToggle(deps(), payload([task.id, foreign.id]) as never);
    expect((await getTask(db, foreign.id))!.status).toBe('open');
  });

  it('returns unknown_card for a message it has no record of', async () => {
    const r = await handleCheckboxToggle(
      deps(),
      payload([], { container: { type: 'message', channel_id: 'C_NL', message_ts: '9.9' } }) as never
    );
    expect(r.outcome).toBe('unknown_card');
  });
});
```

- [ ] **Step 5: Run checkbox test to verify it fails**

Run: `pnpm vitest run apps/slack/src/handlers/checkbox.test.ts`
Expected: FAIL — cannot resolve `../cards.js`

- [ ] **Step 6: Implement card persistence**

`apps/slack/src/cards.ts`:
```ts
import type { Db } from '@tr/db';
import type { CardEntry } from '@tr/slack-ui';

export interface SavedCard {
  task_ids: string[];
  rendered_state: Record<string, boolean>;
  view_scope: string | null;
}

/** Records exactly what was drawn, so a later toggle can be diffed against it. */
export async function saveCard(
  db: Db,
  args: { channelId: string; messageTs: string; entries: CardEntry[]; viewScope?: string | null }
): Promise<void> {
  const taskIds = args.entries.map((e) => e.task.id);
  const rendered: Record<string, boolean> = {};
  for (const e of args.entries) rendered[e.task.id] = e.task.status === 'completed';

  await db.query(
    `INSERT INTO slack_cards (channel_id, message_ts, task_ids, rendered_state, view_scope)
     VALUES ($1, $2, $3::uuid[], $4::jsonb, $5)
     ON CONFLICT (channel_id, message_ts) DO UPDATE
       SET task_ids = EXCLUDED.task_ids,
           rendered_state = EXCLUDED.rendered_state,
           view_scope = EXCLUDED.view_scope,
           updated_at = now()`,
    [args.channelId, args.messageTs, taskIds, JSON.stringify(rendered), args.viewScope ?? null]
  );
}

export async function loadCard(
  db: Db, channelId: string, messageTs: string
): Promise<SavedCard | null> {
  const { rows } = await db.query<SavedCard>(
    `SELECT task_ids, rendered_state, view_scope FROM slack_cards
      WHERE channel_id = $1 AND message_ts = $2`,
    [channelId, messageTs]
  );
  return rows[0] ?? null;
}

/** Returns false when this exact interaction was already processed. */
export async function claimInteraction(
  db: Db, channelId: string, messageTs: string, actionTs: string
): Promise<boolean> {
  const { rows } = await db.query(
    `INSERT INTO processed_interactions (channel_id, message_ts, action_ts)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING channel_id`,
    [channelId, messageTs, actionTs]
  );
  return rows.length > 0;
}
```

- [ ] **Step 7: Implement the toggle handler**

`apps/slack/src/handlers/checkbox.ts`:
```ts
import type { Db } from '@tr/db';
import {
  completeTask, getTask, reopenTask, listSpaces,
  InvalidTaskIdError, type Space, type Task,
} from '@tr/task-core';
import { taskCardBlocks, taskCardFallback, type CardEntry } from '@tr/slack-ui';
import { authorize } from '../auth.js';
import { claimInteraction, loadCard, saveCard } from '../cards.js';
import type { AppConfig } from '../config.js';

export interface CheckboxDeps {
  db: Db;
  client: { chat: { update: (args: Record<string, unknown>) => Promise<unknown> } };
  config: AppConfig;
}

export type ToggleOutcome =
  | 'applied' | 'noop' | 'duplicate' | 'unauthorized' | 'unknown_card';

interface SelectedOption { value?: string }

/**
 * The docs are inconsistent about where checkbox selections live: the state
 * payload documents `selected_options`, while the checkboxes reference example
 * shows `options`. Read the documented location first, then fall back.
 * An empty array is a genuine deselect-all and must not be confused with absence.
 */
export function readSelectedValues(
  body: Record<string, any>, blockId: string, actionId: string
): string[] {
  const fromState = body?.state?.values?.[blockId]?.[actionId]?.selected_options;
  const action = (body?.actions ?? []).find(
    (a: Record<string, unknown>) => a.action_id === actionId
  );
  const chosen: SelectedOption[] | undefined =
    fromState ?? action?.selected_options ?? action?.options;
  if (!Array.isArray(chosen)) return [];
  return chosen.map((o) => o?.value).filter((v): v is string => typeof v === 'string');
}

export async function handleCheckboxToggle(
  deps: CheckboxDeps, body: Record<string, any>
): Promise<{ outcome: ToggleOutcome }> {
  const { db, client, config } = deps;

  const auth = authorize(body as never, config);
  if (!auth.ok) return { outcome: 'unauthorized' };

  const action = (body.actions ?? [])[0];
  const channelId: string | undefined = body.container?.channel_id ?? body.channel?.id;
  const messageTs: string | undefined = body.container?.message_ts;
  const blockId: string = action?.block_id ?? '';
  const actionId: string = action?.action_id ?? '';
  if (!channelId || !messageTs) return { outcome: 'unknown_card' };

  const card = await loadCard(db, channelId, messageTs);
  if (!card) return { outcome: 'unknown_card' };

  const fresh = await claimInteraction(db, channelId, messageTs, action?.action_ts ?? '');

  const selected = new Set(readSelectedValues(body, blockId, actionId));
  const actor = { id: auth.userId, source: 'slack' };
  let applied = false;

  if (fresh) {
    for (const taskId of card.task_ids) {
      const wasRendered = card.rendered_state[taskId] === true;
      const nowSelected = selected.has(taskId);
      if (wasRendered === nowSelected) continue; // this checkbox did not move
      try {
        if (nowSelected) await completeTask(db, taskId, actor);
        else await reopenTask(db, taskId, actor);
        applied = true;
      } catch (err) {
        if (!(err instanceof InvalidTaskIdError)) throw err;
      }
    }
  }

  await redrawCard(deps, channelId, messageTs, card.task_ids, card.view_scope ?? null);

  if (!fresh) return { outcome: 'duplicate' };
  return { outcome: applied ? 'applied' : 'noop' };
}

/** Reads every task back from the database and rewrites the same message. */
export async function redrawCard(
  deps: CheckboxDeps,
  channelId: string,
  messageTs: string,
  taskIds: string[],
  viewScope: string | null
): Promise<void> {
  const { db, client, config } = deps;
  const spaces = new Map((await listSpaces(db)).map((s: Space) => [s.id, s]));

  const entries: CardEntry[] = [];
  for (const id of taskIds) {
    const task: Task | null = await getTask(db, id).catch(() => null);
    const space = task ? spaces.get(task.space_id) : undefined;
    if (task && space) entries.push({ task, space });
  }

  const opts = { timeZone: config.timeZone, assigneeLabels: config.assigneeLabels };
  await client.chat.update({
    channel: channelId,
    ts: messageTs,
    text: taskCardFallback(entries),
    blocks: taskCardBlocks(entries, opts),
  });
  await saveCard(db, { channelId, messageTs, entries, viewScope });
}
```

- [ ] **Step 8: Run checkbox test to verify it passes**

Run: `pnpm vitest run apps/slack/src/handlers/checkbox.test.ts`
Expected: PASS (covers required tests 5, 6, 7, 8, 16, 17, 18)

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(slack): deterministic checkbox complete and uncheck-to-reopen"
```

---

### Task 8: `/task` capture and the Waiting overflow action

**Files:**
- Create: `apps/slack/src/handlers/task-command.ts`, `apps/slack/src/handlers/waiting.ts`
- Modify: `packages/slack-ui/src/card.ts` (add the overflow accessory)
- Test: `apps/slack/src/handlers/task-command.test.ts`, `apps/slack/src/handlers/waiting.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7
- Produces:
  - `handleTaskCommand(deps, command: SlashCommand): Promise<{ created: Task | null; reason?: string }>`
  - `WAITING_ACTION_ID = 'task_waiting'`
  - `handleWaitingAction(deps, body): Promise<{ outcome: 'applied' | 'noop' | 'unauthorized' | 'unknown_card' }>`
  - `taskControlBlocks(entry: CardEntry): KnownBlock[]` — an overflow with a single "Move to Waiting" option

- [ ] **Step 1: Write the failing test**

`apps/slack/src/handlers/task-command.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { handleTaskCommand } from './task-command.js';

let db: Db;
const client = { chat: { postMessage: vi.fn(), postEphemeral: vi.fn() } };
const config = {
  teamId: 'T_RILEY', authorizedUserIds: [], defaultAssigneeId: 'U_JOSH',
  assigneeLabels: { U_JOSH: 'Joshua' }, timeZone: 'America/Chicago', mode: 'socket' as const,
};

beforeEach(async () => {
  db = await createTestDb();
  client.chat.postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1700000000.000200' });
  client.chat.postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  await db.query(
    `INSERT INTO channel_space_map (slack_channel_id, slack_channel_name, space_id)
     SELECT 'C_AGENCY', '#agency-ops', id FROM spaces WHERE name = 'Agency / Internal'`
  );
});
afterEach(async () => { await db.close(); });

const cmd = (text: string, over: Record<string, unknown> = {}) => ({
  text, channel_id: 'C_AGENCY', user_id: 'U_JOSH', team_id: 'T_RILEY',
  command: '/task', ...over,
});

const deps = () => ({ db, client: client as never, config });

// Required tests 1, 4
it('stores the exact title and routes by channel mapping', async () => {
  const raw = 'Offer Neil Instagram and Facebook package for $100';
  const { created } = await handleTaskCommand(deps(), cmd(raw) as never);
  expect(created!.title).toBe(raw);
  const { rows } = await db.query<{ name: string }>(
    `SELECT s.name FROM tasks t JOIN spaces s ON s.id = t.space_id WHERE t.id = $1`,
    [created!.id]
  );
  expect(rows[0]!.name).toBe('Agency / Internal');
});

it('assigns the configured default assignee', async () => {
  const { created } = await handleTaskCommand(deps(), cmd('Call Neil') as never);
  expect(created!.assignee_id).toBe('U_JOSH');
});

it('records the Slack source of the capture', async () => {
  const { created } = await handleTaskCommand(deps(), cmd('Call Neil') as never);
  expect(created!.source_platform).toBe('slack');
  expect(created!.source_channel_id).toBe('C_AGENCY');
  expect(created!.created_by).toBe('U_JOSH');
});

// Required test 3
it('routes an unmapped channel to Inbox and says so', async () => {
  const { created } = await handleTaskCommand(
    deps(), cmd('Buy a new vehicle', { channel_id: 'C_NEW' }) as never
  );
  const { rows } = await db.query<{ name: string }>(
    `SELECT s.name FROM tasks t JOIN spaces s ON s.id = t.space_id WHERE t.id = $1`,
    [created!.id]
  );
  expect(rows[0]!.name).toBe('Inbox');
  const posted = JSON.stringify(client.chat.postMessage.mock.calls[0][0]);
  expect(posted).toContain('Inbox');
});

it('parses a strict due token without altering the remaining title', async () => {
  const { created } = await handleTaskCommand(deps(), cmd('Call Neil due:2026-09-15') as never);
  expect(created!.title).toBe('Call Neil');
  expect(created!.due_at).toBeInstanceOf(Date);
});

it('posts a native checkbox card and records it for later toggles', async () => {
  const { created } = await handleTaskCommand(deps(), cmd('Call Neil') as never);
  const arg = client.chat.postMessage.mock.calls[0][0];
  const el = arg.blocks.find((b: any) => b.type === 'actions').elements[0];
  expect(el.type).toBe('checkboxes');
  expect(el.options[0].value).toBe(created!.id);

  const { rows } = await db.query<{ message_ts: string }>(
    `SELECT message_ts FROM slack_cards WHERE channel_id = 'C_AGENCY'`
  );
  expect(rows[0]!.message_ts).toBe('1700000000.000200');
});

it('rejects an empty command with an ephemeral message and no task', async () => {
  const r = await handleTaskCommand(deps(), cmd('   ') as never);
  expect(r.created).toBeNull();
  expect(client.chat.postMessage).not.toHaveBeenCalled();
  expect(client.chat.postEphemeral).toHaveBeenCalled();
});

// Required test 16
it('rejects an unauthorized workspace with no task created', async () => {
  const r = await handleTaskCommand(deps(), cmd('X', { team_id: 'T_OTHER' }) as never);
  expect(r.created).toBeNull();
  const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM tasks`);
  expect((rows[0] as any).n).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/slack/src/handlers/task-command.test.ts`
Expected: FAIL — cannot resolve `./task-command.js`

- [ ] **Step 3: Implement**

`apps/slack/src/handlers/task-command.ts`:
```ts
import type { Db } from '@tr/db';
import {
  createTask, parseCapture, resolveSpaceForChannel, type Task,
} from '@tr/task-core';
import { taskCardBlocks, taskCardFallback } from '@tr/slack-ui';
import { authorize } from '../auth.js';
import { saveCard } from '../cards.js';
import type { AppConfig } from '../config.js';

export interface CommandDeps {
  db: Db;
  client: {
    chat: {
      postMessage: (args: Record<string, unknown>) => Promise<{ ts?: string }>;
      postEphemeral: (args: Record<string, unknown>) => Promise<unknown>;
    };
  };
  config: AppConfig;
}

interface SlashCommandLike {
  text: string; channel_id: string; user_id: string; team_id: string;
}

export async function handleTaskCommand(
  deps: CommandDeps, command: SlashCommandLike
): Promise<{ created: Task | null; reason?: string }> {
  const { db, client, config } = deps;

  const auth = authorize(
    { team: { id: command.team_id }, user: { id: command.user_id } } as never, config
  );
  if (!auth.ok) {
    await client.chat.postEphemeral({
      channel: command.channel_id, user: command.user_id,
      text: 'You are not authorized to create tasks with this app.',
    });
    return { created: null, reason: auth.reason };
  }

  // The single permitted normalization: one outer trim of the raw command text.
  const { title, dueAt } = parseCapture(command.text ?? '', {
    now: new Date(), timeZone: config.timeZone,
  });
  if (!title) {
    await client.chat.postEphemeral({
      channel: command.channel_id, user: command.user_id,
      text: 'Usage: `/task <task title>` — optionally ending with `due:YYYY-MM-DD`.',
    });
    return { created: null, reason: 'empty_title' };
  }

  const space = await resolveSpaceForChannel(db, command.channel_id);
  const task = await createTask(db, {
    title,
    spaceId: space.id,
    assigneeId: config.defaultAssigneeId,
    dueAt,
    sourcePlatform: 'slack',
    sourceChannelId: command.channel_id,
    createdBy: command.user_id,
  });

  const entries = [{ task, space }];
  const opts = { timeZone: config.timeZone, assigneeLabels: config.assigneeLabels };
  const blocks = taskCardBlocks(entries, opts);
  if (space.is_inbox) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'plain_text',
        text: 'This channel is not mapped to a Space, so the task went to Inbox.',
        emoji: true,
      }],
    } as never);
  }

  const posted = await client.chat.postMessage({
    channel: command.channel_id,
    text: taskCardFallback(entries),
    blocks,
  });

  if (posted.ts) {
    await db.query(`UPDATE tasks SET source_message_ts = $2 WHERE id = $1`, [task.id, posted.ts]);
    await saveCard(db, {
      channelId: command.channel_id, messageTs: posted.ts, entries,
    });
  }

  return { created: task };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/slack/src/handlers/task-command.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing waiting test**

`apps/slack/src/handlers/waiting.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask, getTask, listTasks } from '@tr/task-core';
import { saveCard } from '../cards.js';
import { handleWaitingAction, WAITING_ACTION_ID } from './waiting.js';

let db: Db;
let space: any;
const client = { chat: { update: vi.fn() } };
const config = {
  teamId: 'T_RILEY', authorizedUserIds: [], defaultAssigneeId: 'U_JOSH',
  assigneeLabels: { U_JOSH: 'Joshua' }, timeZone: 'America/Chicago', mode: 'socket' as const,
};

beforeEach(async () => {
  db = await createTestDb();
  client.chat.update = vi.fn().mockResolvedValue({ ok: true });
  const { rows } = await db.query<any>(
    `SELECT id, name, slug, is_inbox FROM spaces WHERE name = 'Client - Milltown Cabinets'`
  );
  space = rows[0];
});
afterEach(async () => { await db.close(); });

const body = (taskId: string, over: Record<string, unknown> = {}) => ({
  type: 'block_actions',
  team: { id: 'T_RILEY' }, user: { id: 'U_JOSH' },
  container: { type: 'message', channel_id: 'C_MC', message_ts: '1700000000.000300' },
  actions: [{
    type: 'overflow', action_id: WAITING_ACTION_ID, block_id: 'task_controls:0',
    action_ts: '1700000002.000002',
    selected_option: { value: `waiting:${taskId}` },
  }],
  ...over,
});

// Required tests 10, 11
it('moves the task to waiting and keeps it out of the actionable list', async () => {
  const task = await createTask(db, {
    title: 'Waiting on Milltown’s reply to the email proposal', spaceId: space.id,
  });
  await saveCard(db, {
    channelId: 'C_MC', messageTs: '1700000000.000300', entries: [{ task, space }],
  });

  const r = await handleWaitingAction({ db, client: client as never, config }, body(task.id) as never);
  expect(r.outcome).toBe('applied');

  const moved = (await getTask(db, task.id))!;
  expect(moved.status).toBe('waiting');
  expect(moved.title).toBe('Waiting on Milltown’s reply to the email proposal');

  const actionable = await listTasks(db, { actionableOnly: true });
  expect(actionable).toHaveLength(0);
});

it('does not complete a waiting task', async () => {
  const task = await createTask(db, { title: 'X', spaceId: space.id });
  await saveCard(db, {
    channelId: 'C_MC', messageTs: '1700000000.000300', entries: [{ task, space }],
  });
  await handleWaitingAction({ db, client: client as never, config }, body(task.id) as never);
  expect((await getTask(db, task.id))!.completed_at).toBeNull();
});

it('redraws the same message in place', async () => {
  const task = await createTask(db, { title: 'X', spaceId: space.id });
  await saveCard(db, {
    channelId: 'C_MC', messageTs: '1700000000.000300', entries: [{ task, space }],
  });
  await handleWaitingAction({ db, client: client as never, config }, body(task.id) as never);
  const arg = client.chat.update.mock.calls[0][0];
  expect(arg.ts).toBe('1700000000.000300');
});

it('rejects an unauthorized user with no mutation', async () => {
  const task = await createTask(db, { title: 'X', spaceId: space.id });
  await saveCard(db, {
    channelId: 'C_MC', messageTs: '1700000000.000300', entries: [{ task, space }],
  });
  const r = await handleWaitingAction(
    { db, client: client as never, config },
    body(task.id, { team: { id: 'T_OTHER' } }) as never
  );
  expect(r.outcome).toBe('unauthorized');
  expect((await getTask(db, task.id))!.status).toBe('open');
});

it('rejects a malformed id in the option value', async () => {
  const task = await createTask(db, { title: 'X', spaceId: space.id });
  await saveCard(db, {
    channelId: 'C_MC', messageTs: '1700000000.000300', entries: [{ task, space }],
  });
  const r = await handleWaitingAction(
    { db, client: client as never, config }, body('not-a-uuid') as never
  );
  expect(r.outcome).toBe('noop');
  expect((await getTask(db, task.id))!.status).toBe('open');
});
```

- [ ] **Step 6: Implement the waiting action and the overflow accessory**

Add to `packages/slack-ui/src/card.ts`:
```ts
export const WAITING_ACTION_ID = 'task_waiting';
export const CONTROLS_BLOCK_PREFIX = 'task_controls';

/**
 * A secondary overflow for state changes the checkbox cannot express.
 * The checkbox remains the only control for open/completed — this never
 * duplicates completion, and there is no Reopen item because unchecking
 * the native checkbox is the reopen gesture.
 */
export function taskControlBlocks(entry: CardEntry, index = 0): KnownBlock[] {
  if (entry.task.status === 'completed') return [];
  const options =
    entry.task.status === 'waiting'
      ? [{ text: { type: 'plain_text' as const, text: 'Move to Open' }, value: `open:${entry.task.id}` }]
      : [{ text: { type: 'plain_text' as const, text: 'Move to Waiting' }, value: `waiting:${entry.task.id}` }];
  return [{
    type: 'actions',
    block_id: `${CONTROLS_BLOCK_PREFIX}:${index}`,
    elements: [{ type: 'overflow', action_id: WAITING_ACTION_ID, options }],
  } as unknown as KnownBlock];
}
```

Export it from `packages/slack-ui/src/index.ts`.

`apps/slack/src/handlers/waiting.ts`:
```ts
import type { Db } from '@tr/db';
import { moveTask, InvalidTaskIdError, TaskNotFoundError } from '@tr/task-core';
import { authorize } from '../auth.js';
import { claimInteraction, loadCard } from '../cards.js';
import { redrawCard, type CheckboxDeps } from './checkbox.js';

export { WAITING_ACTION_ID } from '@tr/slack-ui';

export async function handleWaitingAction(
  deps: CheckboxDeps, body: Record<string, any>
): Promise<{ outcome: 'applied' | 'noop' | 'unauthorized' | 'unknown_card' }> {
  const { db, config } = deps;

  const auth = authorize(body as never, config);
  if (!auth.ok) return { outcome: 'unauthorized' };

  const action = (body.actions ?? [])[0];
  const channelId: string | undefined = body.container?.channel_id ?? body.channel?.id;
  const messageTs: string | undefined = body.container?.message_ts;
  if (!channelId || !messageTs) return { outcome: 'unknown_card' };

  const card = await loadCard(db, channelId, messageTs);
  if (!card) return { outcome: 'unknown_card' };

  const raw: string = action?.selected_option?.value ?? '';
  const [verb, taskId] = raw.split(':', 2);
  if ((verb !== 'waiting' && verb !== 'open') || !taskId) return { outcome: 'noop' };
  if (!card.task_ids.includes(taskId)) return { outcome: 'noop' };

  const fresh = await claimInteraction(db, channelId, messageTs, action?.action_ts ?? '');
  let applied = false;
  if (fresh) {
    try {
      await moveTask(
        db, taskId,
        verb === 'waiting' ? { status: 'waiting' } : { status: 'open', waitingOn: null },
        { id: auth.userId, source: 'slack' }
      );
      applied = true;
    } catch (err) {
      if (!(err instanceof InvalidTaskIdError) && !(err instanceof TaskNotFoundError)) throw err;
    }
  }

  await redrawCard(deps, channelId, messageTs, card.task_ids, card.view_scope ?? null);
  return { outcome: applied ? 'applied' : 'noop' };
}
```

`waiting_on` free text is set through the API or Hermes in Phase 1; the overflow
sets the state without a modal, keeping the Slack surface to one control plus one
secondary menu.

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run apps/slack/src/handlers/`
Expected: PASS (covers required tests 10, 11)

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(slack): /task capture and Waiting overflow action"
```

---

### Task 9: `/tasks` summary and scoped views

**Files:**
- Create: `apps/slack/src/handlers/tasks-command.ts`
- Test: `apps/slack/src/handlers/tasks-command.test.ts`

**Interfaces:**
- Consumes: Tasks 1–8
- Produces: `handleTasksCommand(deps, command: SlashCommandLike): Promise<{ scope: string; count: number }>`

- [ ] **Step 1: Write the failing test**

`apps/slack/src/handlers/tasks-command.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask, completeTask, moveTask } from '@tr/task-core';
import { handleTasksCommand } from './tasks-command.js';

let db: Db;
const spaceIds: Record<string, string> = {};
const client = { chat: { postEphemeral: vi.fn(), postMessage: vi.fn() } };
const config = {
  teamId: 'T_RILEY', authorizedUserIds: [], defaultAssigneeId: 'U_JOSH',
  assigneeLabels: { U_JOSH: 'Joshua' }, timeZone: 'America/Chicago', mode: 'socket' as const,
};
const actor = { id: 'U_JOSH', source: 'test' };

beforeEach(async () => {
  db = await createTestDb();
  client.chat.postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  client.chat.postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1700000000.000400' });
  const { rows } = await db.query<{ id: string; name: string }>(`SELECT id, name FROM spaces`);
  for (const r of rows) spaceIds[r.name] = r.id;
});
afterEach(async () => { await db.close(); });

const cmd = (text: string) => ({
  text, channel_id: 'C_AGENCY', user_id: 'U_JOSH', team_id: 'T_RILEY',
});
const deps = () => ({ db, client: client as never, config });
const add = (space: string, title: string) =>
  createTask(db, { title, spaceId: spaceIds[space]!, assigneeId: 'U_JOSH' });

const posted = () =>
  JSON.stringify(client.chat.postEphemeral.mock.calls[0]?.[0]
    ?? client.chat.postMessage.mock.calls[0][0]);

// Required tests 9, 12
it('summarizes counts per space, excluding completed tasks', async () => {
  const done = await add('Agency / Internal', 'Done');
  await add('Agency / Internal', 'A');
  await add('Marketing', 'B');
  await completeTask(db, done.id, actor);

  await handleTasksCommand(deps(), cmd('') as never);
  const out = posted();
  expect(out).toContain('Agency / Internal');
  expect(out).toContain('Marketing');
  expect(out).not.toContain('Done');
  expect(out).toMatch(/Agency \/ Internal[^0-9]*1/);
});

// Required test 13
it('scopes to a space by partial name with interactive controls', async () => {
  await add('Agency / Internal', 'Agency one');
  await add('Personal', 'Personal one');
  const r = await handleTasksCommand(deps(), cmd('agency') as never);
  expect(r.count).toBe(1);
  const out = posted();
  expect(out).toContain('Agency one');
  expect(out).not.toContain('Personal one');
  expect(out).toContain('checkboxes');
});

it('resolves a multi-word client scope', async () => {
  await add('Client - Joy Within Birth', 'JWB task');
  const r = await handleTasksCommand(deps(), cmd('joy within') as never);
  expect(r.count).toBe(1);
  expect(posted()).toContain('JWB task');
});

it('shows the waiting view and excludes open tasks', async () => {
  const w = await add('Client - Milltown Cabinets', 'Waiting one');
  await add('Marketing', 'Open one');
  await moveTask(db, w.id, { status: 'waiting', waitingOn: 'Milltown' }, actor);

  const r = await handleTasksCommand(deps(), cmd('waiting') as never);
  expect(r.scope).toBe('waiting');
  expect(r.count).toBe(1);
  const out = posted();
  expect(out).toContain('Waiting one');
  expect(out).not.toContain('Open one');
});

it('excludes waiting tasks from a normal space view', async () => {
  const w = await add('Marketing', 'Waiting one');
  await add('Marketing', 'Open one');
  await moveTask(db, w.id, { status: 'waiting' }, actor);
  const r = await handleTasksCommand(deps(), cmd('marketing') as never);
  expect(r.count).toBe(1);
  expect(posted()).toContain('Open one');
});

it('reports an unknown scope without throwing', async () => {
  const r = await handleTasksCommand(deps(), cmd('nonsense-scope') as never);
  expect(r.count).toBe(0);
  expect(posted().toLowerCase()).toContain('no space');
});

it('records posted list cards so their checkboxes work', async () => {
  await add('Marketing', 'B');
  await handleTasksCommand(deps(), cmd('marketing') as never);
  const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM slack_cards`);
  expect((rows[0] as any).n).toBe(1);
});

it('rejects an unauthorized workspace', async () => {
  const r = await handleTasksCommand(
    deps(), { ...cmd(''), team_id: 'T_OTHER' } as never
  );
  expect(r.scope).toBe('unauthorized');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/slack/src/handlers/tasks-command.test.ts`
Expected: FAIL — cannot resolve `./tasks-command.js`

- [ ] **Step 3: Implement**

`apps/slack/src/handlers/tasks-command.ts`:
```ts
import type { Db } from '@tr/db';
import {
  findSpaceByQuery, getTaskCounts, listSpaces, listTasks, listWaiting,
  type Space, type Task,
} from '@tr/task-core';
import { taskListBlocks, taskCardFallback, type CardEntry } from '@tr/slack-ui';
import { authorize } from '../auth.js';
import { saveCard } from '../cards.js';
import type { AppConfig } from '../config.js';

export interface TasksDeps {
  db: Db;
  client: {
    chat: {
      postMessage: (args: Record<string, unknown>) => Promise<{ ts?: string }>;
      postEphemeral: (args: Record<string, unknown>) => Promise<unknown>;
    };
  };
  config: AppConfig;
}

interface SlashCommandLike {
  text: string; channel_id: string; user_id: string; team_id: string;
}

export async function handleTasksCommand(
  deps: TasksDeps, command: SlashCommandLike
): Promise<{ scope: string; count: number }> {
  const { db, client, config } = deps;

  const auth = authorize(
    { team: { id: command.team_id }, user: { id: command.user_id } } as never, config
  );
  if (!auth.ok) {
    await client.chat.postEphemeral({
      channel: command.channel_id, user: command.user_id,
      text: 'You are not authorized to view tasks with this app.',
    });
    return { scope: 'unauthorized', count: 0 };
  }

  const scope = (command.text ?? '').trim().toLowerCase();
  const opts = { timeZone: config.timeZone, assigneeLabels: config.assigneeLabels };
  const spaces = new Map((await listSpaces(db)).map((s: Space) => [s.id, s]));
  const toEntries = (tasks: Task[]): CardEntry[] =>
    tasks.flatMap((task) => {
      const space = spaces.get(task.space_id);
      return space ? [{ task, space }] : [];
    });

  // Summary view
  if (!scope) {
    const counts = await getTaskCounts(db);
    const lines = counts.map((c) => {
      const label = c.space_name.replace(/^Client - /, '');
      const waiting = c.waiting > 0 ? `  (${c.waiting} waiting)` : '';
      return `${label} — ${c.open}${waiting}`;
    });
    await client.chat.postEphemeral({
      channel: command.channel_id, user: command.user_id,
      text: lines.length ? `MY TASKS\n\n${lines.join('\n')}` : 'MY TASKS\n\nNothing open.',
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: lines.length
            ? `*MY TASKS*\n\n${lines.join('\n')}`
            : '*MY TASKS*\n\nNothing open.',
        },
      }],
    });
    return { scope: 'summary', count: counts.reduce((n, c) => n + c.open, 0) };
  }

  // Waiting view
  if (scope === 'waiting' || scope === 'blocked') {
    const entries = toEntries(await listWaiting(db));
    await postList(deps, command, 'WAITING / BLOCKED', entries, 'waiting');
    return { scope: 'waiting', count: entries.length };
  }

  // Space-scoped view
  const space = await findSpaceByQuery(db, scope);
  if (!space) {
    await client.chat.postEphemeral({
      channel: command.channel_id, user: command.user_id,
      text: `No space matches “${command.text.trim()}”. Try \`/tasks\` for the summary.`,
    });
    return { scope, count: 0 };
  }

  const entries = toEntries(
    await listTasks(db, { spaceId: space.id, actionableOnly: true })
  );
  await postList(deps, command, space.name.toUpperCase(), entries, space.slug);
  return { scope: space.slug, count: entries.length };
}

async function postList(
  deps: TasksDeps,
  command: SlashCommandLike,
  heading: string,
  entries: CardEntry[],
  viewScope: string
): Promise<void> {
  const { client, db, config } = deps;
  const opts = { timeZone: config.timeZone, assigneeLabels: config.assigneeLabels };

  if (entries.length === 0) {
    await client.chat.postEphemeral({
      channel: command.channel_id, user: command.user_id,
      text: `*${heading}*\n\nNothing here.`,
    });
    return;
  }

  const blocks = taskListBlocks([{ heading, entries }], opts);
  const posted = await client.chat.postMessage({
    channel: command.channel_id,
    text: `${heading}\n${taskCardFallback(entries)}`,
    blocks,
  });
  if (posted.ts) {
    await saveCard(db, {
      channelId: command.channel_id, messageTs: posted.ts, entries, viewScope,
    });
  }
}
```

Scoped views are posted (not ephemeral) because ephemeral messages cannot be
updated by `chat.update` — and in-place update is the whole interaction model.
The summary view has no interactive controls, so it stays ephemeral.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/slack/src/handlers/tasks-command.test.ts`
Expected: PASS (covers required tests 9, 12, 13)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(slack): /tasks summary and scoped interactive views"
```

---

### Task 10: Bolt wiring and request signature verification

**Files:**
- Create: `apps/slack/src/index.ts`, `apps/slack/src/signature.ts`
- Test: `apps/slack/src/signature.test.ts`

**Interfaces:**
- Consumes: Tasks 1–9
- Produces: `verifySlackSignature(args: { signingSecret: string; requestSignature: string; requestTimestamp: number; body: string; nowSeconds?: number }): boolean`

- [ ] **Step 1: Write the failing test**

`apps/slack/src/signature.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySlackSignature } from './signature.js';

const secret = 'test_signing_secret';
const body = 'token=abc&command=%2Ftask&text=Call+Neil';
const ts = 1_700_000_000;

const sign = (t: number, b: string, s = secret) =>
  `v0=${createHmac('sha256', s).update(`v0:${t}:${b}`).digest('hex')}`;

it('accepts a correctly signed request', () => {
  expect(verifySlackSignature({
    signingSecret: secret, requestSignature: sign(ts, body),
    requestTimestamp: ts, body, nowSeconds: ts + 5,
  })).toBe(true);
});

it('rejects a tampered body', () => {
  expect(verifySlackSignature({
    signingSecret: secret, requestSignature: sign(ts, body),
    requestTimestamp: ts, body: `${body}&injected=1`, nowSeconds: ts + 5,
  })).toBe(false);
});

it('rejects a signature made with the wrong secret', () => {
  expect(verifySlackSignature({
    signingSecret: secret, requestSignature: sign(ts, body, 'wrong'),
    requestTimestamp: ts, body, nowSeconds: ts + 5,
  })).toBe(false);
});

it('rejects a replay older than five minutes', () => {
  expect(verifySlackSignature({
    signingSecret: secret, requestSignature: sign(ts, body),
    requestTimestamp: ts, body, nowSeconds: ts + 301,
  })).toBe(false);
});

it('rejects a timestamp from the future beyond tolerance', () => {
  expect(verifySlackSignature({
    signingSecret: secret, requestSignature: sign(ts, body),
    requestTimestamp: ts, body, nowSeconds: ts - 301,
  })).toBe(false);
});

it('rejects a malformed or empty signature without throwing', () => {
  for (const requestSignature of ['', 'v0=', 'garbage', 'v1=abc']) {
    expect(verifySlackSignature({
      signingSecret: secret, requestSignature,
      requestTimestamp: ts, body, nowSeconds: ts + 5,
    })).toBe(false);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/slack/src/signature.test.ts`
Expected: FAIL — cannot resolve `./signature.js`

- [ ] **Step 3: Implement**

`apps/slack/src/signature.ts`:
```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

const FIVE_MINUTES = 60 * 5;

export interface VerifyArgs {
  signingSecret: string;
  requestSignature: string;
  requestTimestamp: number;
  body: string;
  nowSeconds?: number;
}

/** Used only in HTTP mode. Socket Mode authenticates via the app-level token. */
export function verifySlackSignature(args: VerifyArgs): boolean {
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(args.requestTimestamp)) return false;
  if (Math.abs(now - args.requestTimestamp) > FIVE_MINUTES) return false;

  const expected = `v0=${createHmac('sha256', args.signingSecret)
    .update(`v0:${args.requestTimestamp}:${args.body}`)
    .digest('hex')}`;

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(args.requestSignature ?? '', 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/slack/src/signature.test.ts`
Expected: PASS

- [ ] **Step 5: Wire up the Bolt app**

`apps/slack/src/index.ts`:
```ts
import 'dotenv/config';
import Bolt from '@slack/bolt';
import { createDb, migrate } from '@tr/db';
import { CHECKBOX_ACTION_ID, WAITING_ACTION_ID } from '@tr/slack-ui';
import { loadConfig } from './config.js';
import { handleCheckboxToggle } from './handlers/checkbox.js';
import { handleWaitingAction } from './handlers/waiting.js';
import { handleTaskCommand } from './handlers/task-command.js';
import { handleTasksCommand } from './handlers/tasks-command.js';

const config = loadConfig();
const db = await createDb();
await migrate(db);

const app = new Bolt.App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  ...(config.mode === 'socket'
    ? { socketMode: true, appToken: process.env.SLACK_APP_TOKEN }
    : { socketMode: false }),
});

app.command('/task', async ({ command, ack, client }) => {
  await ack();
  await handleTaskCommand({ db, client: client as never, config }, command as never);
});

app.command('/tasks', async ({ command, ack, client }) => {
  await ack();
  await handleTasksCommand({ db, client: client as never, config }, command as never);
});

// The native checkbox is the single task-state control, in both directions.
app.action(CHECKBOX_ACTION_ID, async ({ ack, body, client }) => {
  await ack();
  await handleCheckboxToggle({ db, client: client as never, config }, body as never);
});

app.action(WAITING_ACTION_ID, async ({ ack, body, client }) => {
  await ack();
  await handleWaitingAction({ db, client: client as never, config }, body as never);
});

app.error(async (error) => {
  console.error('[slack] unhandled error', error);
});

await app.start(config.mode === 'socket' ? undefined : Number(process.env.PORT ?? 3000));
console.log(`[slack] running in ${config.mode} mode`);
```

`ack()` is called before the handler runs so Slack always receives its
acknowledgement inside the 3-second window; the mutation and redraw then proceed.
Slack's own retry of an unacknowledged delivery is absorbed by
`processed_interactions`.

- [ ] **Step 6: Verify the app boots and typechecks**

Run: `pnpm typecheck`
Expected: no errors

Run: `SLACK_MODE=socket pnpm slack`
Expected: fails with a Slack auth error about a missing/invalid token — this
confirms wiring is correct and only credentials are absent. Ctrl-C to exit.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(slack): Bolt wiring, Socket Mode, and signature verification"
```

---

### Task 11: REST API for Hermes

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/index.ts`, `apps/api/src/server.ts`
- Test: `apps/api/src/server.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5
- Produces: `buildServer(deps: { db: Db; apiToken: string | null }): FastifyInstance`

- [ ] **Step 1: Write the failing test**

`apps/api/src/server.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { createTask } from '@tr/task-core';
import { buildServer } from './server.js';

let db: Db;
let app: ReturnType<typeof buildServer>;
let spaceId: string;

beforeEach(async () => {
  db = await createTestDb();
  app = buildServer({ db, apiToken: 'secret-token' });
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM spaces WHERE name = 'Client - Nazareth Law'`
  );
  spaceId = rows[0]!.id;
});
afterEach(async () => { await app.close(); await db.close(); });

const auth = { authorization: 'Bearer secret-token' };

it('rejects an unauthenticated request', async () => {
  const r = await app.inject({ method: 'GET', url: '/tasks' });
  expect(r.statusCode).toBe(401);
});

// Required test 14
it('returns exact titles', async () => {
  const raw = 'Offer Neil Instagram and Facebook package for $100';
  await createTask(db, { title: raw, spaceId });
  const r = await app.inject({ method: 'GET', url: '/tasks', headers: auth });
  expect(r.statusCode).toBe(200);
  expect(r.json().tasks[0].title).toBe(raw);
});

it('creates a task with the exact title supplied', async () => {
  const raw = 'Consolidate 401(k): move Corebridge to Fidelity';
  const r = await app.inject({
    method: 'POST', url: '/tasks', headers: auth,
    payload: { title: raw, space_id: spaceId },
  });
  expect(r.statusCode).toBe(201);
  expect(r.json().task.title).toBe(raw);
});

// Required test 15
it('offers no route that can change a title', async () => {
  const task = await createTask(db, { title: 'Original exact title', spaceId });

  // A title in a move payload is ignored, not honoured.
  const moved = await app.inject({
    method: 'POST', url: `/tasks/${task.id}/move`, headers: auth,
    payload: { status: 'waiting', title: 'AI-rewritten title' },
  });
  expect(moved.statusCode).toBe(200);
  expect(moved.json().task.title).toBe('Original exact title');

  // No update route exists at all.
  for (const method of ['PATCH', 'PUT'] as const) {
    const r = await app.inject({ method, url: `/tasks/${task.id}`, headers: auth });
    expect([404, 405]).toContain(r.statusCode);
  }
});

it('completes and reopens a task idempotently', async () => {
  const task = await createTask(db, { title: 'Call Neil', spaceId });
  const a = await app.inject({ method: 'POST', url: `/tasks/${task.id}/complete`, headers: auth });
  const b = await app.inject({ method: 'POST', url: `/tasks/${task.id}/complete`, headers: auth });
  expect(a.json().task.completed_at).toBe(b.json().task.completed_at);

  const c = await app.inject({ method: 'POST', url: `/tasks/${task.id}/reopen`, headers: auth });
  expect(c.json().task.status).toBe('open');
  expect(c.json().task.completed_at).toBeNull();
});

// Required test 17
it('rejects a malformed task id with 400, not 500', async () => {
  const r = await app.inject({
    method: 'POST', url: '/tasks/not-a-uuid/complete', headers: auth,
  });
  expect(r.statusCode).toBe(400);
});

it('404s a well-formed unknown id', async () => {
  const r = await app.inject({
    method: 'POST', url: '/tasks/00000000-0000-4000-8000-000000000000/complete',
    headers: auth,
  });
  expect(r.statusCode).toBe(404);
});

it('serves spaces, waiting, and counts', async () => {
  const t = await createTask(db, { title: 'W', spaceId });
  await app.inject({
    method: 'POST', url: `/tasks/${t.id}/move`, headers: auth,
    payload: { status: 'waiting', waiting_on: 'Neil' },
  });
  expect((await app.inject({ method: 'GET', url: '/spaces', headers: auth })).json().spaces)
    .toHaveLength(11);
  expect((await app.inject({ method: 'GET', url: '/waiting', headers: auth })).json().tasks[0].waiting_on)
    .toBe('Neil');
  expect((await app.inject({ method: 'GET', url: '/counts', headers: auth })).json().counts[0].waiting)
    .toBe(1);
});

it('filters the task list by space and status', async () => {
  await createTask(db, { title: 'NL task', spaceId });
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM spaces WHERE name = 'Marketing'`
  );
  await createTask(db, { title: 'Mkt task', spaceId: rows[0]!.id });
  const r = await app.inject({
    method: 'GET', url: `/tasks?space_id=${spaceId}&actionable=true`, headers: auth,
  });
  expect(r.json().tasks.map((t: any) => t.title)).toEqual(['NL task']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/api/src/server.test.ts`
Expected: FAIL — cannot resolve `./server.js`

- [ ] **Step 3: Implement**

`apps/api/package.json`:
```json
{
  "name": "@tr/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@tr/db": "workspace:*",
    "@tr/task-core": "workspace:*",
    "fastify": "^5.1.0",
    "dotenv": "^16.4.5"
  }
}
```

`apps/api/src/server.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '@tr/db';
import {
  completeTask, createTask, getTask, getTaskCounts, listSpaces, listTasks,
  listWaiting, moveTask, reopenTask,
  InvalidTaskIdError, TaskNotFoundError, type TaskStatus,
} from '@tr/task-core';

export interface ApiDeps { db: Db; apiToken: string | null }

export function buildServer(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const { db } = deps;

  app.addHook('onRequest', async (req, reply) => {
    if (!deps.apiToken) {
      return reply.code(503).send({ error: 'API_TOKEN not configured' });
    }
    const header = req.headers.authorization ?? '';
    if (header !== `Bearer ${deps.apiToken}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof InvalidTaskIdError) return reply.code(400).send({ error: 'invalid_task_id' });
    if (err instanceof TaskNotFoundError) return reply.code(404).send({ error: 'task_not_found' });
    return reply.code(500).send({ error: 'internal_error' });
  });

  const actor = (req: { headers: Record<string, unknown> }) => ({
    id: typeof req.headers['x-actor-id'] === 'string' ? (req.headers['x-actor-id'] as string) : null,
    source: 'api',
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/spaces', async () => ({ spaces: await listSpaces(db) }));

  app.get('/tasks', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return {
      tasks: await listTasks(db, {
        spaceId: q.space_id,
        assigneeId: q.assignee_id,
        actionableOnly: q.actionable === 'true',
        status: q.status as TaskStatus | undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    };
  });

  app.get('/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await getTask(db, id);
    if (!task) return reply.code(404).send({ error: 'task_not_found' });
    return { task };
  });

  app.get('/waiting', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return { tasks: await listWaiting(db, { spaceId: q.space_id }) };
  });

  app.get('/counts', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return { counts: await getTaskCounts(db, { assigneeId: q.assignee_id }) };
  });

  /**
   * The title is taken verbatim. There is deliberately no route, anywhere,
   * that can change a title once stored.
   */
  app.post('/tasks', async (req, reply) => {
    const b = req.body as Record<string, unknown>;
    if (typeof b?.title !== 'string' || b.title.length === 0) {
      return reply.code(400).send({ error: 'title_required' });
    }
    if (typeof b?.space_id !== 'string') {
      return reply.code(400).send({ error: 'space_id_required' });
    }
    const task = await createTask(db, {
      title: b.title,
      spaceId: b.space_id,
      assigneeId: typeof b.assignee_id === 'string' ? b.assignee_id : null,
      dueAt: typeof b.due_at === 'string' ? new Date(b.due_at) : null,
      sourcePlatform: typeof b.source_platform === 'string' ? b.source_platform : 'api',
      createdBy: typeof b.created_by === 'string' ? b.created_by : null,
    });
    return reply.code(201).send({ task });
  });

  app.post('/tasks/:id/complete', async (req) => {
    const { id } = req.params as { id: string };
    return { task: await completeTask(db, id, actor(req as never)) };
  });

  app.post('/tasks/:id/reopen', async (req) => {
    const { id } = req.params as { id: string };
    return { task: await reopenTask(db, id, actor(req as never)) };
  });

  app.post('/tasks/:id/move', async (req) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    // Only these three keys are read. A `title` key is ignored.
    return {
      task: await moveTask(db, id, {
        spaceId: typeof b.space_id === 'string' ? b.space_id : undefined,
        status: typeof b.status === 'string' ? (b.status as TaskStatus) : undefined,
        waitingOn: typeof b.waiting_on === 'string' ? b.waiting_on : undefined,
      }, actor(req as never)),
    };
  });

  return app;
}
```

`apps/api/src/index.ts`:
```ts
import 'dotenv/config';
import { createDb, migrate } from '@tr/db';
import { buildServer } from './server.js';

const db = await createDb();
await migrate(db);

const app = buildServer({ db, apiToken: process.env.API_TOKEN?.trim() || null });
await app.listen({ port: Number(process.env.API_PORT ?? 3030), host: '0.0.0.0' });
console.log(`[api] listening on ${process.env.API_PORT ?? 3030}`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/api/src/server.test.ts`
Expected: PASS (covers required tests 14, 15, 17)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): REST read/write layer with no title-mutation route"
```

---

### Task 12: MCP server for Hermes

**Files:**
- Create: `packages/mcp/package.json`, `packages/mcp/tsconfig.json`, `packages/mcp/src/tools.ts`, `packages/mcp/src/index.ts`
- Test: `packages/mcp/src/tools.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5
- Produces: `buildTools(db: Db): McpTool[]` where `McpTool = { name: string; description: string; inputSchema: object; handler(args: Record<string, unknown>): Promise<unknown> }`; exported `TOOL_NAMES: string[]`

- [ ] **Step 1: Write the failing test**

`packages/mcp/src/tools.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { buildTools, TOOL_NAMES } from './tools.js';

let db: Db;
let tools: Map<string, (a: Record<string, unknown>) => Promise<any>>;
let spaceId: string;

beforeEach(async () => {
  db = await createTestDb();
  tools = new Map(buildTools(db).map((t) => [t.name, t.handler]));
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM spaces WHERE name = 'Client - Nazareth Law'`
  );
  spaceId = rows[0]!.id;
});
afterEach(async () => { await db.close(); });

const call = (name: string, args: Record<string, unknown> = {}) => tools.get(name)!(args);

it('exposes exactly the eight contracted tools', () => {
  expect(TOOL_NAMES.sort()).toEqual([
    'complete_task', 'create_task', 'get_task', 'get_task_counts',
    'list_spaces', 'list_tasks', 'list_waiting', 'move_task',
  ]);
});

// Required test 18
it('exposes no tool that can rename a task', () => {
  expect(TOOL_NAMES.some((n) => /title|rename|edit|update/i.test(n))).toBe(false);
});

// Required test 14
it('returns exact titles', async () => {
  const raw = 'Offer Neil Instagram and Facebook package for $100';
  await call('create_task', { title: raw, space_id: spaceId });
  const out = await call('list_tasks', {});
  expect(out.tasks[0].title).toBe(raw);
});

// Required test 15
it('ignores a title passed to move_task', async () => {
  const { task } = await call('create_task', { title: 'Original exact title', space_id: spaceId });
  await call('move_task', { task_id: task.id, status: 'waiting', title: 'AI-rewritten' });
  const { task: read } = await call('get_task', { task_id: task.id });
  expect(read.title).toBe('Original exact title');
  expect(read.status).toBe('waiting');
});

it('rejects create_task with a missing or non-string title', async () => {
  await expect(call('create_task', { space_id: spaceId })).rejects.toThrow();
  await expect(call('create_task', { title: 42, space_id: spaceId })).rejects.toThrow();
});

// Required test 17
it('rejects a malformed task id', async () => {
  await expect(call('complete_task', { task_id: 'not-a-uuid' })).rejects.toThrow();
});

it('completes idempotently', async () => {
  const { task } = await call('create_task', { title: 'Call Neil', space_id: spaceId });
  const a = await call('complete_task', { task_id: task.id });
  const b = await call('complete_task', { task_id: task.id });
  expect(a.task.completed_at).toEqual(b.task.completed_at);
});

it('reports counts and waiting separately from actionable tasks', async () => {
  const { task } = await call('create_task', { title: 'W', space_id: spaceId });
  await call('move_task', { task_id: task.id, status: 'waiting', waiting_on: 'Neil' });
  expect((await call('list_tasks', { actionable_only: true })).tasks).toHaveLength(0);
  expect((await call('list_waiting', {})).tasks[0].waiting_on).toBe('Neil');
  expect((await call('get_task_counts', {})).counts[0].waiting).toBe(1);
});

it('lists all spaces', async () => {
  expect((await call('list_spaces', {})).spaces).toHaveLength(11);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/mcp/src/tools.test.ts`
Expected: FAIL — cannot resolve `./tools.js`

- [ ] **Step 3: Implement**

`packages/mcp/package.json`:
```json
{
  "name": "@tr/mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@tr/db": "workspace:*",
    "@tr/task-core": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "dotenv": "^16.4.5"
  }
}
```

`packages/mcp/src/tools.ts`:
```ts
import type { Db } from '@tr/db';
import {
  completeTask, createTask, getTask, getTaskCounts, listSpaces, listTasks,
  listWaiting, moveTask, TaskNotFoundError, type TaskStatus,
} from '@tr/task-core';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>): Promise<unknown>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const HERMES = { id: null, source: 'hermes-mcp' };

export function buildTools(db: Db): McpTool[] {
  return [
    {
      name: 'list_tasks',
      description:
        'List tasks with exact titles. Set actionable_only to exclude waiting and completed tasks.',
      inputSchema: {
        type: 'object',
        properties: {
          space_id: { type: 'string' },
          assignee_id: { type: 'string' },
          status: { type: 'string', enum: ['open', 'waiting', 'completed'] },
          actionable_only: { type: 'boolean' },
          limit: { type: 'number' },
        },
      },
      handler: async (a) => ({
        tasks: await listTasks(db, {
          spaceId: str(a.space_id),
          assigneeId: str(a.assignee_id),
          status: str(a.status) as TaskStatus | undefined,
          actionableOnly: a.actionable_only === true,
          limit: typeof a.limit === 'number' ? a.limit : undefined,
        }),
      }),
    },
    {
      name: 'get_task',
      description: 'Get one task by id, with its exact title.',
      inputSchema: {
        type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'],
      },
      handler: async (a) => {
        const task = await getTask(db, String(a.task_id));
        if (!task) throw new TaskNotFoundError(String(a.task_id));
        return { task };
      },
    },
    {
      name: 'create_task',
      description:
        'Create a task. The title is stored exactly as given and can never be changed afterwards. ' +
        'Do not summarize, rewrite, combine, or split what the user said.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          space_id: { type: 'string' },
          assignee_id: { type: 'string' },
          due_at: { type: 'string', description: 'ISO 8601 timestamp' },
        },
        required: ['title', 'space_id'],
      },
      handler: async (a) => {
        const title = str(a.title);
        const spaceId = str(a.space_id);
        if (!title) throw new Error('title must be a non-empty string');
        if (!spaceId) throw new Error('space_id must be a string');
        return {
          task: await createTask(db, {
            title, spaceId,
            assigneeId: str(a.assignee_id) ?? null,
            dueAt: str(a.due_at) ? new Date(String(a.due_at)) : null,
            sourcePlatform: 'hermes',
            createdBy: str(a.created_by) ?? null,
          }),
        };
      },
    },
    {
      name: 'complete_task',
      description: 'Mark a task completed. Idempotent. Requires explicit user authorization.',
      inputSchema: {
        type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'],
      },
      handler: async (a) => ({ task: await completeTask(db, String(a.task_id), HERMES) }),
    },
    {
      name: 'move_task',
      description:
        'Change a task’s space, status, or waiting_on. Cannot change the title — any title ' +
        'field is ignored. Requires explicit user instruction.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          space_id: { type: 'string' },
          status: { type: 'string', enum: ['open', 'waiting', 'completed'] },
          waiting_on: { type: 'string' },
        },
        required: ['task_id'],
      },
      handler: async (a) => ({
        task: await moveTask(db, String(a.task_id), {
          spaceId: str(a.space_id),
          status: str(a.status) as TaskStatus | undefined,
          waitingOn: str(a.waiting_on),
        }, HERMES),
      }),
    },
    {
      name: 'list_spaces',
      description: 'List all Spaces. Space names are deterministic configuration data.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ spaces: await listSpaces(db) }),
    },
    {
      name: 'list_waiting',
      description: 'List waiting/blocked tasks. These are not normal actionable tasks.',
      inputSchema: { type: 'object', properties: { space_id: { type: 'string' } } },
      handler: async (a) => ({ tasks: await listWaiting(db, { spaceId: str(a.space_id) }) }),
    },
    {
      name: 'get_task_counts',
      description: 'Per-space open and waiting counts. Completed tasks are excluded.',
      inputSchema: { type: 'object', properties: { assignee_id: { type: 'string' } } },
      handler: async (a) => ({ counts: await getTaskCounts(db, { assigneeId: str(a.assignee_id) }) }),
    },
  ];
}

export const TOOL_NAMES: string[] = [
  'list_tasks', 'get_task', 'create_task', 'complete_task', 'move_task',
  'list_spaces', 'list_waiting', 'get_task_counts',
];
```

`packages/mcp/src/index.ts`:
```ts
import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createDb, migrate } from '@tr/db';
import { buildTools } from './tools.js';

const db = await createDb();
await migrate(db);
const tools = buildTools(db);
const byName = new Map(tools.map((t) => [t.name, t]));

const server = new Server(
  { name: 'team-riley-tasks', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = byName.get(req.params.name);
  if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
  const result = await tool.handler((req.params.arguments ?? {}) as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

await server.connect(new StdioServerTransport());
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/mcp/src/tools.test.ts`
Expected: PASS (covers required tests 14, 15, 17, 18)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(mcp): Hermes tool layer over task-core with no rename capability"
```

---

### Task 13: Documentation and full-suite verification

**Files:**
- Create: `README.md`, `ARCHITECTURE.md`, `SLACK_SETUP.md`, `MCP_CONTRACT.md`, `MIGRATION_PLAN.md`
- Create: `tests/determinism.test.ts`

**Interfaces:**
- Consumes: everything
- Produces: documentation and a cross-cutting guard test

- [ ] **Step 1: Write the cross-cutting guard test**

`tests/determinism.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOTS = ['packages', 'apps'];

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...(await sourceFiles(path)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

// Required test 18, enforced repository-wide
it('contains no title-mutating SQL anywhere', async () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of await sourceFiles(root)) {
      const text = await readFile(file, 'utf8');
      if (/UPDATE\s+tasks\s+SET[^;]*\btitle\b/is.test(text)) offenders.push(file);
    }
  }
  expect(offenders).toEqual([]);
});

it('contains no fuzzy title matching in any mutation path', async () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of await sourceFiles(root)) {
      const text = await readFile(file, 'utf8');
      if (/title\s+(I?LIKE|~)/i.test(text) || /WHERE[^;]*lower\(\s*title\s*\)/is.test(text)) {
        offenders.push(file);
      }
    }
  }
  expect(offenders).toEqual([]);
});

it('makes no LLM or AI service calls', async () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of await sourceFiles(root)) {
      const text = await readFile(file, 'utf8');
      if (/api\.openai\.com|anthropic\.com\/v1|generativelanguage\.googleapis/i.test(text)) {
        offenders.push(file);
      }
    }
  }
  expect(offenders).toEqual([]);
});
```

- [ ] **Step 2: Run the full suite**

Run: `pnpm test`
Expected: all tests pass. Record the count for the final report.

- [ ] **Step 3: Typecheck the whole workspace**

Run: `pnpm typecheck`
Expected: no errors

- [ ] **Step 4: Write the five documents**

`README.md` — what it is, the core principle, local setup (`pnpm install`,
`cp .env.example .env`, `pnpm test`, `pnpm slack`), the command reference
(`/task`, `/tasks`, `/tasks <scope>`, `/tasks waiting`), and the `due:` grammar.

`ARCHITECTURE.md` — the adapter/core split and why `task-core` has no title
write path; the dual database driver; the `slack_cards` diffing model and why
whole-group reconciliation was rejected; the two idempotency layers.

`SLACK_SETUP.md` — creating the new dedicated app; the scope list
(`commands`, `chat:write`); Socket Mode with `connections:write` on the
app-level token; slash command registration for `/task` and `/tasks`;
interactivity enablement; the channel→Space mapping table; and the **one runtime
verification step**: post a task, complete it, and confirm the label renders
struck through and the box stays checked.

`MCP_CONTRACT.md` — the eight tools with schemas, what Hermes may and may not
do, and the explicit statement that no title-mutating tool exists.

`MIGRATION_PLAN.md` — deferred to Phase 2, must preserve exact titles, plus the
three findings from the export: `Music` appears as a top-level category though
the brief lists Music as a Personal sub-domain; `Personal tasks` vs `Personal`;
and importing `details` (up to 3,224 chars) requires adding a nullable `details`
column that Phase 1 deliberately omits.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: architecture, Slack setup, MCP contract, and migration plan"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: §1 core principle → Tasks 4,
11, 12, 13; §2 verified platform facts → Task 6; §3 interaction model → Tasks 6, 7;
§4 `initial_options` trap → Task 6 Step 7; §5 data model → Tasks 1, 2; §6 due
parsing → Task 3; §7 idempotency → Tasks 4, 7; §8 authorization → Task 7; §9
spaces → Task 2; §10 Hermes → Tasks 11, 12; §11 storage/runtime → Tasks 1, 10;
§12 testing → all; §13 deferrals → Task 13.

**Required test coverage.** 1 → Task 3, 8. 2 → Task 2. 3 → Tasks 2, 8. 4 → Task 4.
5 → Task 7. 6 → Tasks 4, 7. 7 → Task 7. 8 → Tasks 6, 7. 9 → Tasks 5, 9.
10 → Tasks 5, 8. 11 → Tasks 4, 8. 12 → Tasks 5, 9. 13 → Tasks 5, 9. 14 → Tasks
11, 12. 15 → Tasks 4, 11, 12. 16 → Tasks 7, 8, 9. 17 → Tasks 4, 11, 12. 18 →
Tasks 4, 12, 13.

**Type consistency.** `Db`, `Task`, `Space`, `TaskStatus`, `Actor`, `MetaOpts`,
`CardEntry`, `AppConfig`, and `CheckboxDeps` are each defined once and imported
thereafter. `redrawCard` is defined in Task 7 and reused by Task 8.
`WAITING_ACTION_ID` is defined in `@tr/slack-ui` (Task 8) and re-exported from
the handler so both the renderer and the Bolt wiring reference one constant.

**Known gap carried deliberately.** `waiting_on` free text has no Slack input in
Phase 1 — the overflow sets the state, and the text is set via API or Hermes.
Adding a modal would expand the Slack surface beyond one control plus one
secondary menu.
