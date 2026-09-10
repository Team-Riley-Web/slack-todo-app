# Migration Plan

Deferred to Phase 2 by design. Phase 1 was built and tested against an empty
database; nothing has been imported.

**The absolute requirement: migration must preserve exact task titles.** An
importer that normalizes, trims beyond the outer trim, re-cases, or "cleans up"
a title has failed regardless of what else it does.

## Source of truth for this plan

`docs/workast-export-2026-09-09.json` — 21 non-completed Team Riley tasks, live
Workast API, exported 2026-09-10T00:11Z. Read for design context only; not
imported.

## What the export actually contains

| Property | Finding |
|---|---|
| Tasks | 21, all `status: pending` |
| Categories | 7 |
| Title length | min 15, median 47, **max 63** |
| Titles over 72 chars | **0** — the checkbox truncation path never fires |
| Titles containing `* _ ~` or backtick | **0** — mrkdwn exposure is theoretical |
| Non-ASCII in titles | `’` (2 tasks), `—` (1 task) |
| Tasks with an assignee | 14 of 21 (all Joshua Riley); 7 unassigned |
| Multi-assignee tasks | 0 |
| Tasks waiting | 1 (`waiting: true`, `waiting_on: null`, tag `Waiting`) |
| Tasks with a due date | 1 — `2026-11-13 09:00:00 America/Chicago` |
| Tasks with `details` | 21 of 21; **longest 3,224 chars** |

Two of these already shaped Phase 1: `due_at` is `timestamptz` because the
export carries date + time + zone, and truncation counts code points because of
`’` and `—`.

## Three decisions — RESOLVED 2026-09-09

### 1. `Music` is a top-level category in Workast

The brief lists Music as a *Personal sub-domain*, alongside Body, Spiritual,
Money, Croatian. The export has it as a peer of Marketing and Agency / Internal,
with 2 open tasks.

**Decision: Music is its own Space.** Matches how it is actually used, and does
not block on the Phase 2 sub-list work. Seeded by
`migrations/004_music_space_and_aliases.sql`; there are now 12 Spaces.

### 2. `Personal tasks` vs `Personal`

The export says `Personal tasks`; the brief and the seeded Space say `Personal`.
**Decision: `Personal tasks` is a configured alias for the `Personal` Space.**

Rather than a one-off importer special case, `space_aliases` is a real table —
enumerated exact matches, seeded with `personal tasks` → `Personal`. Canonical
names take precedence over aliases, and aliases never enable partial matching
(`personal task` singular still resolves to nothing). Hermes gets this for free:
someone saying "add it to personal tasks" resolves correctly.

### 3. `details` has nowhere to go

Every task carries `details` — workstream, next actor, priority, source, scope,
and explicit boundaries, up to 3,224 characters. It is real content, not
boilerplate.

The task model specified in the brief has no notes field, and Phase 1 follows
that exactly rather than quietly widening the schema. Importing this content
requires:

```sql
-- migrations/003_add_details.sql
ALTER TABLE tasks ADD COLUMN details text;
```

**Decision: added.** `migrations/003_task_details.sql` adds a nullable `details
text` column.

It is **write-at-create and read-only thereafter** — `createTask` accepts it,
REST and MCP expose it on both create paths, reads return it, and no route or
tool can change it. A `details` key on a move payload is ignored exactly as a
`title` key is. That keeps it a record of what was captured rather than a mutable
notes field, and a test asserts the absence of an update path.

Still open: `source_external_id UNIQUE` for idempotent re-import (see below). Not
added, since only `details` was approved.

## Proposed category → Space mapping

| Workast category | Count | Space | Note |
|---|---|---|---|
| Agency / Internal | 7 | Agency / Internal | exact |
| Marketing | 3 | Marketing | exact |
| Client - Nazareth Law | 2 | Client - Nazareth Law | exact |
| Client - Secure Logic | 2 | Client - Secure Logic | exact |
| Client - Milltown Cabinets | 1 | Client - Milltown Cabinets | exact |
| Personal tasks | 4 | Personal | via `space_aliases` |
| Music | 2 | Music | own Space |

Spaces with no open tasks today — Sales, Client - Joy Within Birth,
Client - CFC Skincare, Client - Yoga Farm — are already seeded and need nothing.

Every one of the 21 exported tasks now has a resolvable destination.

## Field mapping

| Workast | Task column | Rule |
|---|---|---|
| `title` | `title` | **byte-exact, no normalization whatsoever** |
| `category` | `space_id` | via the table above; unmapped → Inbox, never guessed |
| `status: pending` + `waiting: false` | `status` | `open` |
| `waiting: true` | `status` | `waiting` |
| `waiting_on` | `waiting_on` | null stays null |
| `due_date` + `due_time` + `due_timezone` | `due_at` | compose to `timestamptz`; date-only → midnight in `DEFAULT_TIMEZONE` |
| `assignees[0].email` | `assignee_id` | needs an email → Slack ID map; empty → null, not a default |
| `workast_task_id` | — | see below |
| `canonical_source_id` | — | see below |
| `details` | `details` | verbatim; column added in migration 003 |
| `tags` | — | dropped; only value present is `Waiting`, already encoded in `status` |
| — | `source_platform` | `'workast'` |
| — | `created_at` | import timestamp; Workast export carries no creation date |

`created_at` cannot be recovered from this export — it has no creation
timestamps. Imported tasks will all appear created at import time, which affects
stale-task reporting for pre-existing work. Worth knowing before running it.

## Idempotency

Re-running the importer must not duplicate. Two `workast_task_id` /
`canonical_source_id` columns have nowhere to go in the current schema either, so
the importer should either:

- add `source_external_id text UNIQUE` alongside `details` in the same migration
  (preferred — makes re-import a no-op), or
- run once, from a checked-in manifest, and never again.

Without one of these there is no safe way to re-run a partially-failed import.

## Order of work

1. ~~Get decisions 1–3 from Joshua.~~ Done 2026-09-09.
2. ~~Add the `details` column.~~ Done — migration 003. Still needed:
   `source_external_id text UNIQUE` for idempotent re-import.
3. Write the importer against a copy of the export, in a test, asserting all 21
   titles round-trip byte-exact — including the `’` and `—` ones.
4. Dry-run against a scratch database; diff the 21 titles against the export.
5. Import to production; spot-check in Slack via `/tasks`.
6. Leave Workast read-only for a week before decommissioning.

## Hermes Kanban

No manifest yet. Same requirements: exact titles, deterministic space mapping, an
idempotent external id. Blocked on a Kanban export being produced.

## Not migrating

The five Daily Anchors — Meditate, Exercise, Journal, Cold Exposure, Vocal
Warm-Ups — stay external with their Google Sheet tracking, per the brief.
