# Team Riley Tasks

A Slack-native task manager. A native Slack checkbox is the single task-state
control; task titles are stored byte-exact; Hermes reads and writes through a
REST/MCP layer that cannot rename a task.

This is not a project-management product. There is no Gantt, no time tracking,
no dependency graph, no comments, no attachments, no analytics dashboard.

## Core principle

AI is not in the task mutation path.

```
/task Offer Neil Instagram and Facebook package for $100
```

stores the title `Offer Neil Instagram and Facebook package for $100` — byte for
byte. Nothing rewrites, summarizes, normalizes, or improves it. The only
normalization anywhere is a single outer `.trim()` of the raw slash-command text.

This is enforced structurally rather than by validation: `packages/task-core` is
the only code that may mutate a task, and it exposes no title-writing function.
Hermes cannot rename a task because the capability does not exist to call.

## Local setup

```bash
pnpm install
cp .env.example .env      # fill in Slack credentials — see SLACK_SETUP.md
pnpm test                 # 158 tests, no credentials or database needed
pnpm typecheck
```

With no `DATABASE_URL`, the app runs on embedded PGlite (real Postgres compiled
to WASM) — no Postgres install, no Docker. Set `DATABASE_URL=file://./.pglite`
to persist locally, or a `postgres://` URL to use Supabase.

```bash
pnpm migrate              # apply migrations and seed Spaces
pnpm sync-channels        # apply config/channel-map.json to the database
pnpm slack                # Slack app (Socket Mode)
pnpm api                  # REST API on :3030
pnpm mcp                  # MCP server on stdio, for Hermes
pnpm prune-interactions   # prune dedupe rows past the retention window
pnpm import-tasks -- --help  # import legacy tasks; see IMPORT.md
```

Note `prune-interactions`, not `prune` — `pnpm prune` is a pnpm built-in that
prunes `node_modules`, and pnpm's own commands take precedence over scripts.

## Commands

| Command | Effect |
|---|---|
| `/task <title>` | Capture a task. Space comes from the channel mapping. |
| `/task <title> due:2026-09-15` | Same, with a due date. |
| `/tasks` | **From a mapped channel:** that Space's list. **From an unmapped channel or DM:** per-Space counts. |
| `/tasks all` | Force the cross-Space summary from anywhere. |
| `/tasks agency` | Full interactive list for a Space, matched by partial name. |
| `/tasks joy within` | Multi-word Space scopes work. |
| `/tasks waiting` | Everything waiting or blocked. |

Every task card carries a small ⋮ menu with **Move to Waiting** (one click) and
**Edit task…**, which opens a window holding every field: title, Space, status,
assignee, due date and time, waiting-on, and notes. Nothing is required except
the title, so `/task Call Neil` stays a single clean line and the fields are
there only when a task earns them. A completed card is just the ticked box and
the struck-through title — no menu.

Bare `/tasks` is channel-aware because someone standing in
`#client-secure-logic` asking for "tasks" means that client's tasks. An unmapped
channel or a DM carries no such context, so it falls back to the summary.

### Due-date grammar

Strict and deterministic. Only these forms are recognised, and only as the very
last token:

```
due:2026-09-15   due:today   due:tomorrow   due:mon … due:sun
```

Anything else stays part of the title. `due:wed` on a Wednesday means *next*
Wednesday. Relative dates resolve against `DEFAULT_TIMEZONE`.

`/task due tomorrow is part of this title` stores that whole sentence as the
title, because `due tomorrow` is not the strict `due:` form.

## Channel → Space mapping

Deterministic configuration, never inferred. Copy the example and fill in real
Slack channel IDs:

```bash
cp config/channel-map.example.json config/channel-map.json
pnpm sync-channels            # add --prune to delete mappings absent from config
```

```json
{
  "C0123456789": { "name": "#client-secure-logic", "space": "Client - Secure Logic" },
  "C0123456790": { "name": "#agency-ops",          "space": "Agency / Internal" }
}
```

A Space may be named by its canonical name (`Client - Secure Logic`), its slug
(`secure-logic`), its name without the client prefix (`Secure Logic`), or a
configured alias (`Personal tasks` → `Personal`). Any other value aborts the
whole sync rather than importing a partial mapping.

Twelve Spaces are seeded: Inbox, Agency / Internal, Marketing, Sales, Personal,
Music, and the six clients.

An unmapped channel routes to **Inbox**. Client identity is never inferred from
channel or message text.

## The task card

```
Open:       [ ] Offer Neil Instagram and Facebook package for $100
                Nazareth Law · Joshua · due Sep 15

Completed:  [x] ~Offer Neil Instagram and Facebook package for $100~
                Completed Sep 9 · Nazareth Law
```

The checkbox is the only state control, in both directions. Checking completes;
unchecking reopens. There is no Complete button, no Reopen button, no text glyph
imitating a checkbox, and no inert completed icon. The same message is updated in
place; no extra message is posted.

A single-task card also carries a small overflow with one item — *Move to
Waiting* — for the state the checkbox cannot express.

## Layout

```
apps/slack        Bolt app: slash commands and block actions
apps/api          Fastify REST API for Hermes
packages/db       query/exec interface, PGlite + node-postgres drivers, migrations
packages/task-core  the ONLY task mutation path
packages/slack-ui   Block Kit rendering
packages/mcp        MCP stdio server for Hermes
tests             repository-wide determinism guards
docs              spec, plan, and the Workast export used for design
```

## Documents

- `ARCHITECTURE.md` — why the boundaries are where they are
- `SLACK_SETUP.md` — creating the app, scopes, and the one runtime check
- `MCP_CONTRACT.md` — the eight Hermes tools and their limits
- `IMPORT.md` — importing legacy tasks: the flow, formats, duplicates, rollback
- `MIGRATION_PLAN.md` — the Workast and Kanban migration plan
