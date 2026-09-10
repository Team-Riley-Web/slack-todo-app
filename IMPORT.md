# Importing legacy tasks

Nothing is written to your task database without an explicit confirmation, and
every batch can be rolled back. Task titles are stored byte for byte as the
source has them.

## Two ways in

**In Slack**, run `/import`. This is the normal route, and it needs no
terminal:

1. Pick a file and say whether it is CSV, JSON, or a Workast export. The
   source type is asked rather than guessed, because a Workast export and a
   plain JSON file are both valid JSON and mean different things.
2. The file is read and staged. Whatever already matches a Space by name, slug
   or alias is resolved silently; anything left over becomes a question with a
   native `static_select` per unresolved category.
3. A preview shows the per-verdict counts and the exact titles that will be
   created. Its submit button is the only thing in the system that flips a
   batch to `CONFIRMED`, and with nothing ready to import the button is not
   rendered at all — so a no-op cannot be confirmed.
4. Confirming closes the modal and posts a report: how many were imported,
   skipped, or need review, whether every title verified byte-exact, and the
   batch id to roll back with.

Closing the wizard at any point before confirming marks the batch `ABORTED`
rather than leaving it staged forever.

Two details worth knowing. `/import` needs the `files:read` scope, so adding
it requires reinstalling the Slack app. And each step acknowledges Slack
before doing its work, because Slack discards a modal submission that is not
answered within 3 seconds and staging a large file does not fit in that
budget — which is why you briefly see a "Working" view.

**In a terminal**, use the CLI. Same engine, same batches, same rollback.

## The short version

```bash
# 1. Look. This writes nothing.
pnpm import-tasks -- --file docs/workast-export-2026-09-09.json \
  --type workast --map config/workast-mapping.json

# 2. If the preview looks right, write it.
pnpm import-tasks -- --file docs/workast-export-2026-09-09.json \
  --type workast --map config/workast-mapping.json \
  --confirm --actor U01ABCDEF

# 3. Changed your mind.
pnpm import-tasks -- --rollback <batch-id>
```

Other commands:

```bash
pnpm import-tasks -- --list            # every batch, newest first
pnpm import-tasks -- --batch <id>      # one batch with its audit summary
```

## The nine steps

| Step | What happens | Writes tasks? |
|---|---|---|
| 1. Source | You give it a file and a `--type` | no |
| 2. Parse | An adapter turns bytes into staging rows | no |
| 3. Mapping | Source categories, assignees and statuses resolve to canonical ones | no |
| 4. Duplicate analysis | Every row gets a verdict | no |
| 5. Preview | Counts and the exact rows are printed | no |
| 6. Confirmation | `--confirm --actor <id>` | — |
| 7. Import | One transaction | **yes** |
| 8. Verification | Every written task is read back and compared | no |
| 9. Report | Counts, source ids, task ids, batch id | no |

Steps 1 to 5 are safe to run as often as you like. `importBatch` refuses any
batch that is not `CONFIRMED`, so the gate is a property of the state machine,
not a habit.

## Verdicts

Each row gets exactly one:

- **READY** — will become a task.
- **SKIP_DUPLICATE** — already imported, or a task already carries this source
  id, or the same record appears twice in this file.
- **NEEDS_REVIEW** — a task with this exact title already exists in the same
  Space with the same status. **Not** imported and **not** merged. You decide.
- **INVALID** — cannot become a task: no title, an unmapped Space, an unmapped
  status, or one of the Daily Anchors.

## How duplicates are decided

Strictly in this order, all exact comparisons. There is no fuzzy matching
anywhere, and a test greps the whole package to prove it.

1. This source record was already imported **and its task still exists** →
   `SKIP_DUPLICATE`.
2. A task already carries this `source_external_id` → `SKIP_DUPLICATE`.
3. Exact title **and** same Space **and** same active status → `NEEDS_REVIEW`.

Rule 3 is deliberately not an automatic skip. The match is exact, but the
conclusion is not — two genuinely different tasks can share a title inside one
Space, and silently merging them is the mistake this importer exists to
prevent.

The "and its task still exists" clause in rule 1 is what lets you roll back a
bad import, fix the mapping, and import the same file again. Audit rows survive
a rollback on purpose, so without it a rolled-back batch would block its own
file forever.

## Idempotency

Re-running the same file imports nothing. The key is:

- the source's own record id when it has one (Workast task id, Kanban task id);
- otherwise `sha256(source_type ⟂ title ⟂ source_space ⟂ source_created_at)`,
  hex, where `⟂` is a NUL byte so different field splits cannot collide.

Never the title alone. Two different tasks are allowed to share a title.

## Mapping file

```json
{
  "spaces": {
    "Personal tasks": "Personal",
    "Team Riley Operations": "Agency / Internal"
  },
  "assignees": { "josh@teamrileyweb.com": "U01ABCDEF" },
  "statuses": { "pending": "open" },
  "defaultSpace": "Inbox"
}
```

A Space may be named by its canonical name, its slug, its name without the
`Client - ` prefix, or a configured alias. An unmapped source category makes its
rows `INVALID` — it is never guessed. `defaultSpace` fills only rows that have
no source category at all; it never overrides one.

An explicit `waiting: true` on a source record beats any status mapping, because
otherwise mapping `pending → open` would silently un-park every waiting task.

`config/workast-mapping.json` is the mapping for the real migration. Fill in the
assignee's Slack user id before using it.

## CSV and JSON format

Recognised columns, all optional except `title`:

```
source_record_id, title, space, list_state, assignee,
due_at, waiting_on, created_at, completed_at, status
```

Any other column is preserved under `source_metadata` rather than dropped, so a
provider export can be fed in unmodified. JSON accepts a top-level array or an
object with a `tasks`, `records`, or `items` array.

## Adapters

| Source | Status |
|---|---|
| Normalized CSV | ready |
| Normalized JSON | ready |
| **Workast** | **ready, and verified against the real 21-task export** |
| Hermes Kanban | **blocked** — no sample manifest exists yet |

The Workast adapter is tested against `docs/workast-export-2026-09-09.json`
itself, including the titles carrying `’` and `—`, the one waiting flag, the one
due date with its `09:00:00 America/Chicago` time, and the 3,224-character
`details` field. A full-pipeline test imports that file for real and checks all
21 tasks land in the right seven Spaces.

The Kanban adapter is not written, because there is nothing to write it against.
A synthetic fixture would prove the code runs, not that the field names match.
Produce a manifest and it is a small job.

## Rollback

`--rollback <batch-id>` **hard-deletes** the tasks that batch created. That is
the chosen behaviour, and it is the one place this system deletes task rows.

Two guards:

- A task worked on since it was imported — anything beyond its own creation
  event — is **refused** and reported. `--force` overrides.
- `import_audit` rows are never deleted. Each affected row gains a
  `ROLLED_BACK` entry, so the record of what happened outlives the tasks.

Rolling back twice is safe. Rolling back a batch that was never imported is
refused.

## What cannot be imported

The five Daily Anchors — Meditate, Exercise, Journal, Cold Exposure, Vocal
Warm-Ups — are marked `INVALID` on an exact title match, so they cannot enter
the task system through an import. They stay in their Google Sheet. A task that
merely mentions one of those words ("Meditate with Rachael on Tuesday") is a
normal task and imports normally.

## Limits and safety

- 10 MiB per file, 20,000 rows, both checked **before** parsing.
- The declared `--type` must agree with the file's actual contents; a `.csv`
  holding JSON is rejected.
- Malformed input fails with a row number and stages nothing.
- Uploaded content is only ever parsed as data. Nothing is executed.
- A formula-injection sanitizer exists for any future export path, so an export
  added later cannot forget it.

## One thing to know before you migrate

**The Workast export contains no creation timestamps.** Imported tasks will all
show as created at import time, which affects stale-task reporting for work that
actually predates the migration. Due dates, completion dates, waiting state, and
details all survive; creation dates cannot, because they are not in the file.

## What Hermes can do

Read only: `list_import_batches`, `get_import_batch`, `preview_import`,
`get_import_conflicts`. It can inspect batches, explain conflicts, and suggest
mappings. It cannot confirm, import, roll back, merge a duplicate, or rename
anything — a test seeds a confirmed batch, calls every import tool, and asserts
nothing was written.
