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

This is enforced structurally rather than by validation. A title can be changed
— you can edit one in the Slack modal or on the web edit page — but there is
exactly **one** function that writes `tasks.title`, `editTask` in
`packages/task-core`, and it is reachable from those two human surfaces and
nowhere else. No MCP tool and no REST route can reach it, so Hermes cannot
rename a task: the capability does not exist to call. Three tests in
`tests/determinism.test.ts` assert all of that. See ARCHITECTURE.md.

## Local setup

```bash
pnpm install
cp .env.example .env      # fill in Slack credentials — see SLACK_SETUP.md
pnpm test                 # 652 tests, no credentials or database needed
pnpm typecheck
```

With no `DATABASE_URL`, the Slack app, API and MCP server run on embedded
PGlite (real Postgres compiled to WASM) — no Postgres install, no Docker. Set
`DATABASE_URL=file://./.pglite` to persist locally, or a `postgres://` URL to
use Supabase.

The web app is the exception: it **requires** a `postgres://` URL, because
PGlite's WASM cannot load inside the bundled Next server. See WEB.md.

```bash
pnpm migrate              # apply migrations and seed Spaces
pnpm sync-channels        # apply config/channel-map.json to the database
pnpm slack                # Slack app (Socket Mode)
pnpm api                  # REST API on :3030
pnpm mcp                  # MCP server on stdio, for Hermes
pnpm prune-interactions   # prune dedupe rows past the retention window
pnpm import-tasks -- --help  # import legacy tasks; see IMPORT.md
pnpm --filter @tr/web dev # web UI on :3040; see WEB.md
```

Note `prune-interactions`, not `prune` — `pnpm prune` is a pnpm built-in that
prunes `node_modules`, and pnpm's own commands take precedence over scripts.

## Commands

| Command | Effect |
|---|---|
| `/task` | **No text:** opens the full capture modal — Space, new Space, status, assignee, due, details. |
| `/task <title>` | Capture a task in one line. Space comes from the channel mapping. |
| `/task <title> due:2026-09-15` | Same, with a due date. |
| `/tasks` | **From a mapped channel:** that Space's list. **Otherwise:** every open task, grouped by Space. |
| `/tasks all` | Every open task grouped by Space, from anywhere. |
| `/tasks summary` | Per-Space counts only, no checkboxes. |
| `/space` | This channel's Space: pick one, create one, or unmap. One modal. |
| `/import` | Import tasks from a CSV or JSON file, entirely in Slack. See IMPORT.md. |
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

### Times written in a title

`/task Call Andre at 3:30` sets a due date of today at 15:30 and stores the
title as **`Call Andre at 3:30`** — every byte, the time included.

That is the difference from `due:`. A `due:` token is a *directive*, so it is
stripped. "at 3:30" is prose you typed, so it stays. The card says outright
that the due date was inferred, rather than quietly setting a date you never
asked for.

Deterministic, no LLM. A time is recognised only with one of two signals:

| Written | Read as |
|---|---|
| `at 3:30`, `by 5`, `@ 9:15` | a preposition marks it as a time |
| `3:30pm`, `9am`, `3:30 p.m.` | am/pm marks it, no preposition needed |
| `at 15:30` | 24-hour, already unambiguous |
| `Fix ratio 2:1`, `Read chapter 3` | **not** a time — no due date set |

An hour with no am/pm uses a fixed daytime table, then rolls to tomorrow if
that instant has already passed:

| Written | Read as |
|---|---|
| 1–6 | afternoon, 13:00–18:00 |
| 7–11 | morning, 07:00–11:00 |
| 12 | noon |

So at 14:45, `at 1:00` is 13:00 — gone, so 13:00 **tomorrow**. Write `1am`
when you do mean the small hours.

A typo is refused rather than guessed at: `at 1:oo` with letter o's sets no
due date, which is visible and fixable, unlike a date invented from a
misspelling.

A `due:` token and a time combine: `Call Andre at 3:30 due:tomorrow` is
tomorrow at 03:30. The token picks the day, the title picks the clock.

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

## Task actions

A card is the checkbox and nothing else. Everything else is in Slack's own
**More actions** (⋮) menu on the message: **Edit task** and **Toggle
Waiting**. When a card holds several tasks the app asks which one you mean
rather than acting on the first.

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
apps/slack        Bolt app: slash commands, block actions, the edit modal, the import wizard
apps/api          Fastify REST API for Hermes
apps/web          Next.js web UI: lists, filters, history, settings, editing
packages/db       query/exec/transaction interface, PGlite + node-postgres, migrations
packages/task-core  the ONLY task mutation path
packages/slack-ui   Block Kit rendering
packages/slack-sync  card storage, locking, and redrawing — shared by Slack and web
packages/importer   parsing, analysis, staged import, rollback
packages/mcp        MCP stdio server for Hermes
tests             repository-wide determinism guards
docs              specs, plans, and the Workast export used for design
```

## Documents

- `ARCHITECTURE.md` — why the boundaries are where they are
- `WEB.md` — the web UI: views, the Postgres requirement, auth, deploying
- `SLACK_SETUP.md` — creating the app, scopes, and the one runtime check
- `MCP_CONTRACT.md` — the eight Hermes tools and their limits
- `IMPORT.md` — importing legacy tasks: the flow, formats, duplicates, rollback
- `MIGRATION_PLAN.md` — the Workast and Kanban migration plan
