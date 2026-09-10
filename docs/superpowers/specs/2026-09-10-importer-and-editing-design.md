# Phase 2A Design — Importer engine, full-field editing, reporting

Date: 2026-09-10
Status: Approved
Scope: Phase 2A only. The web UI is Phase 2B.

## 1. Why 2A is separate from the web UI

The brief describes two independent subsystems. The importer is headless — parse,
stage, map, analyze, write, verify, roll back — and needs no browser. The web UI
is another adapter over `task-core` that happens to host the importer's approval
screens.

All the data-corruption risk lives in 2A, it is verifiable without a browser, and
it unblocks the real Workast and Kanban migration before any UI exists. Building
both in one pass would mean a shallower version of each, and shallow on the
importer means damaged task data.

2A ships: the importer engine, the Slack full-field edit modal, and the reporting
queries. 2B ships the web UI (Next.js + Slack OAuth) and the import approval
screens on top of a working engine.

## 2. The title guarantee changes shape

Until now `title` was unwritable by any code path, enforced by a repository-wide
grep. That was the system's strongest property. Editing requires giving it up —
but only in the direction that was never the threat.

The threat the guarantee existed to stop is **AI silently rewriting what you
said**. A human fixing their own typo is not that. So:

- **One** function writes `title`: `editTask` in `task-core`.
- It is reachable from exactly two human surfaces: the Slack modal
  (`view_submission`, authorized user) and, in 2B, the web UI's server action
  (authenticated Slack OAuth session).
- It is **not** an MCP tool and **not** a REST route. Hermes remains
  structurally unable to rename, combine, or split a task.

The guard test changes from *"no title write exists"* to *"exactly one title
write exists, at this path, and it is unreachable from the Hermes surfaces"* —
asserted against the MCP tool list and the Fastify route table, not against
prose. That is a weaker invariant than before, stated plainly, and it is still
strong where it matters.

`editTask` takes an explicit typed patch and reads nothing outside it:

```
editTask(db, id, {
  title?, spaceId?, status?, waitingOn?, assigneeId?, dueAt?, details?
}, actor)
```

One UPDATE, one `edited` audit event carrying a before/after diff of only the
fields that actually changed. An unchanged submit writes nothing and logs
nothing. The narrow deterministic functions (`completeTask`, `reopenTask`,
`moveTask`, `updateTaskDetails`) stay exactly as they are and remain the only
paths Slack's checkbox, REST, and MCP use.

## 3. Slack edit modal

Reached from the existing overflow on open and waiting cards, as a second item
alongside Move to Waiting / Move to Open. Verified platform facts:

| Fact | Consequence |
|---|---|
| `views.open` needs only a `trigger_id` and the bot token | scope list stays `commands` + `chat:write` |
| **Only `input` blocks appear in `view_submission` state values** | every editable field must be an `input` block, never a section accessory |
| `optional: true` on an input block permits an empty submission | this is how due date, assignee, and waiting_on get cleared |
| `plain_text_input` caps at 3000 chars | a title longer than 3000 cannot be edited from Slack; the web UI has no such cap |
| `response_action` may be returned from `view_submission` | field-level validation errors render in the modal instead of failing silently |

Fields, all in `input` blocks:

| Field | Element | Notes |
|---|---|---|
| Title | `plain_text_input`, `initial_value` = current title | required; outer trim only, byte-exact otherwise |
| Space | `static_select` over the 12 seeded Spaces | required |
| Status | `static_select` — open / waiting / completed | required |
| Assignee | `users_select` | optional; empty clears |
| Due date | `datepicker` | optional; empty clears; resolved at `DEFAULT_TIMEZONE` midnight, same rule as the `due:` parser |
| Waiting on | `plain_text_input` | optional; ignored unless status is waiting |
| Details | `plain_text_input`, `multiline` | optional; empty clears |

`private_metadata` carries `{ taskId, channelId, messageTs }` as JSON so the
submission handler knows which task to write and which card to redraw. The
handler authorizes with the same `authorize()` used everywhere, validates before
`ack`, and on success calls `editTask` then redraws the originating card through
the existing `withCardLock` so a modal submit cannot interleave with a checkbox
toggle.

**The completed card is unchanged.** It stays checkbox-only — no overflow, no
extra controls — exactly as specified. A completed task is edited from the web UI
in 2B, or by unchecking it first. The checkbox remains the only task-state
control *on a card*; the modal is an explicit edit form, not a competing control.

## 4. Importer architecture

A new `packages/importer` owns the pipeline and calls `task-core` for every
write. It issues no task SQL of its own. Adapters are pure functions — bytes in,
normalized staging rows out — so each is testable with no database.

```
adapter(bytes) -> StagingRow[]        // pure, no DB
stage(batch, rows)                    // writes import_staging only
applyMapping(batch, mapping)          // resolves space/assignee/status
analyze(batch)                        // assigns a verdict per row
confirm(batch, actor)                 // the human gate
importBatch(batch)                    // one transaction, then read-back
rollbackBatch(batch, opts)            // hard delete, guarded
```

Nothing writes to `tasks` before `confirm`.

## 5. Data model

**`import_batches`** — one per upload. State machine
`PARSED → MAPPED → ANALYZED → CONFIRMED → IMPORTED`, plus `ROLLED_BACK` and
`ABORTED`. Holds source type, filename, the mapping config as jsonb, counts,
`created_by`, `confirmed_by`, `confirmed_at`, `imported_at`, `rolled_back_at`.
Illegal transitions are rejected — `importBatch` refuses a batch that is not
`CONFIRMED`, which is how "explicit confirmation required before write" becomes a
property rather than a convention.

**`import_staging`** — one row per source record, carrying the brief's field list
verbatim (`source_type`, `source_record_id`, `title`, `space`, `list_state`,
`assignee`, `due_at`, `waiting_on`, `created_at`, `completed_at`, `status`,
`source_metadata`) plus resolved values (`resolved_space_id`,
`resolved_assignee_id`, `resolved_status`, `resolved_due_at`), the verdict
(`READY` | `SKIP_DUPLICATE` | `NEEDS_REVIEW` | `INVALID`), a `reason`, a
`duplicate_task_id`, and `canonical_task_id` once written.

`title` in staging is the source bytes, untouched. Mapping never rewrites it.

**`import_audit`** — the brief's schema exactly: `id`, `batch_id`, `source_type`,
`source_record_id`, `canonical_task_id`, `action`, `reason`, `created_at`.
Actions: `IMPORTED`, `SKIPPED_DUPLICATE`, `NEEDS_REVIEW`, `FAILED`, plus
`ROLLED_BACK` appended on rollback. **Audit rows survive rollback** — the record
of what happened is never destroyed, even though the tasks are.

**Two columns on `tasks`:** `source_external_id text` and
`import_batch_id uuid`, with a unique index on
`(source_platform, source_external_id) WHERE source_external_id IS NOT NULL`.
That column was flagged as the open gap after the Phase 1 QA pass; it is now the
idempotency key.

## 6. Duplicate and idempotency strategy

Strictly ordered, entirely deterministic, no fuzzy matching anywhere:

1. `(source_type, source_record_id)` already recorded `IMPORTED` in
   `import_audit` → **SKIP_DUPLICATE**. This is the re-run case.
2. A task already carries that `source_external_id` → **SKIP_DUPLICATE**.
3. Exact title **and** same resolved Space **and** same active status →
   **NEEDS_REVIEW**, reporting the matching task id.

Step 3 is deliberately not an auto-skip. The match is exact, but the conclusion
is not: two genuinely different tasks can share a title in one Space, and
silently merging them is the failure this importer exists to prevent. A human
decides.

When a source provides no record id, the key is
`sha256(source_type | title | source_space | source_created_at)`, hex-encoded and
documented — stable across re-runs of the same file, and never title alone.

**INVALID** covers: empty or whitespace-only title, a source category the mapping
does not cover, an unparseable date in a date field, and an exact match against
the Daily Anchors denylist (Meditate, Exercise, Journal, Cold Exposure, Vocal
Warm-Ups) with reason "tracked externally" — so the anchors cannot enter the task
system through an import.

## 7. Transactions — a real change to `packages/db`

"Transactionally where possible" is currently not possible. `Db` exposes `query`
and `exec` over a **pool**, so consecutive calls can land on different
connections and `BEGIN`/`COMMIT` would not bracket anything.

`Db` gains `transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>`: a pinned
client with `BEGIN`/`COMMIT`/`ROLLBACK` for `pg`, `pglite.transaction()` for
PGlite. The callback receives a `Db` bound to that one connection, so
`task-core` functions work unchanged inside it.

A failed import rolls back to zero written tasks. That is what makes "a failed
import does not partially corrupt task data" testable rather than hoped for.

## 8. Read-back verification

After the transaction commits, every imported row is re-read by its
`canonical_task_id` and compared: `title` **byte-exact**, plus space, status,
`completed_at`, `due_at`, and `source_external_id`. Any mismatch marks the row
`FAILED` in the audit and fails the batch loudly. Success is never reported on an
unverified write.

## 9. Rollback — hard delete, guarded

Chosen behavior, per explicit instruction: **rollback hard-deletes the tasks
created by that batch.**

Two guards, both from the brief:

- A task whose `task_events` contain any event from a non-import actor has been
  touched since import. Rollback **refuses** it and reports it, unless called
  with an explicit `force` flag.
- `import_audit` rows are never deleted; each affected row gains a `ROLLED_BACK`
  entry.

`task_events` for a deleted task are removed in the same transaction (they
describe a row that no longer exists). `slack_cards` hold task ids in an array
with no foreign key, and `redrawCard` already skips ids that no longer resolve —
verified in Phase 1 — so a rolled-back task simply disappears from its card.

Noted tension: this is the one place the system deletes task rows, against its
retain-everything posture elsewhere. It is scoped to un-touched rows from a single
identified bad import batch, which is a different act from deleting real work.

## 10. Supported formats

| Format | Status |
|---|---|
| Normalized CSV | implemented |
| Normalized JSON | implemented |
| Workast export | implemented, **tested against the real 21-task export** in `docs/workast-export-2026-09-09.json` |
| Hermes Kanban manifest | adapter + documented manifest schema, tested against synthetic fixtures only |

The Kanban adapter is marked awaiting-a-real-manifest. No sample exists, and
inventing one to claim coverage would be false confidence. The Workast adapter is
verified against real data, including the `’` and `—` titles that broke naive
assumptions in Phase 1.

Space mapping is deterministic configuration: source category → canonical Space,
resolved through the existing exact matcher (canonical name, slug,
client-prefix-free name, or a configured alias). An unmapped category is
`INVALID`, never guessed. Personal sub-domain mapping is supported only when
explicitly configured; nothing infers a domain from task text.

Completed history: `completed_at` and `created_at` are preserved when the source
provides them, and a historical completed task is never reopened by import.

## 11. Security controls

- Extension **and** content sniff must agree; a `.csv` holding JSON is rejected.
- 10 MB file limit, 20,000 row limit, both configurable, both enforced before
  parsing rather than after.
- Malformed input produces a rejection with a row number, never a stack trace and
  never a partial stage.
- Uploaded content is only ever parsed as data. Nothing is executed, no path from
  the upload reaches the filesystem or a shell.
- CSV formula-injection sanitizer (`=`, `+`, `-`, `@`, tab, CR prefixes) lives in
  the importer package for any future export path. Nothing exports today; the
  helper exists so an export added later cannot forget it.
- No credential is read, logged, or returned by any importer code path.

## 12. Hermes surface — read-only

New MCP tools, all reads: `list_import_batches`, `get_import_batch`,
`preview_import` (returns a staged batch's rows and verdicts — it does not accept
a file), `get_import_conflicts` (the `NEEDS_REVIEW` and `INVALID` rows with
reasons, plus any unmapped source categories as suggestions).

Hermes may inspect batches, explain conflicts, and suggest mappings. It may not
confirm, import, roll back, merge a duplicate, or rename anything. `confirm` and
`import` require an actor and are exposed only to CLI and, in 2B, the web UI.

Reporting queries, also read-only, exposed over MCP and REST: open count by
Space, completed count by date range, waiting list, created this week, completed
this week, average task age, stale tasks.

## 13. Testing

The brief's 25 tests map as follows. Tests 1-7 are web UI and belong to 2B; 8-25
are 2A:

8 CSV parses · 9 JSON parses · 10 malformed rejected · 11 exact title preserved ·
12 Space mapping · 13 duplicate `source_record_id` skips · 14 re-run idempotent ·
15 ambiguous duplicate → NEEDS_REVIEW · 16 no fuzzy auto-merge · 17 explicit
confirmation required · 18 read-back verifies · 19 audit row created · 20 failed
import does not partially corrupt · 21 rollback affects only its batch ·
22 completed history preserves `completed_at` · 23 Kanban adapter preserves
source id · 24 Workast adapter preserves Workast id · 25 Daily Anchors excluded.

Plus, beyond the brief: `editTask` cannot be reached from MCP or REST; an
unchanged modal submit writes nothing; the transaction actually rolls back on a
mid-import failure; and the derived idempotency key is stable across runs.

## 14. Deferred

Web UI and import approval screens (2B). Gantt, time tracking, dependencies,
billing, chat, comments, attachments, CRM, complex permissions, AI task
rewriting, autonomous bulk cleanup — none of these, per the brief.
