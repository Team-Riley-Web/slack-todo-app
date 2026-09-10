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
pnpm slack                # Slack app (Socket Mode)
pnpm api                  # REST API on :3030
pnpm mcp                  # MCP server on stdio, for Hermes
```

## Commands

| Command | Effect |
|---|---|
| `/task <title>` | Capture a task. Space comes from the channel mapping. |
| `/task <title> due:2026-09-15` | Same, with a due date. |
| `/tasks` | Per-space counts of open (and waiting) tasks. |
| `/tasks agency` | Full interactive list for a Space, matched by partial name. |
| `/tasks joy within` | Multi-word Space scopes work. |
| `/tasks waiting` | Everything waiting or blocked. |

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
- `MIGRATION_PLAN.md` — Workast/Kanban import, deferred to Phase 2
