# Architecture

## The one invariant

`packages/task-core` is the only code permitted to mutate a task. Everything
else — `apps/slack`, `apps/api`, `packages/mcp` — parses input, authorizes,
calls core, and renders. No adapter issues SQL.

Core's entire mutation surface:

```
createTask({ title, spaceId, ... })  -> stores title verbatim, write-once
getTask(id)
completeTask(id, actor)              -> status + completed_at only
reopenTask(id, actor)                -> status + completed_at only
moveTask(id, { spaceId, status, waitingOn }, actor)
```

There is no `updateTitle`. This is the difference between a guarantee and a
guardrail: a guard can be bypassed by a new code path, but Hermes cannot rename a
task through *any* path because no function, route, or tool accepts a title for
an existing task. `moveTask` reads exactly three keys off its patch object, so a
`title` key passed alongside them is not rejected — it is simply never read.

Three tests enforce this from different angles: core's exported names are checked
for title-writing functions, `tests/determinism.test.ts` greps every source file
for title-mutating SQL, and the REST and MCP suites each pass a `title` into a
move and assert the stored title is unchanged.

## Storage

One interface, two drivers, chosen by `DATABASE_URL`:

```ts
interface Db {
  query(sql, params)  // parameterized, single statement (extended protocol)
  exec(sql)           // multi-statement script, no params (simple protocol)
  close()
}
```

- No URL or `memory://` → PGlite, embedded real Postgres. Dev and tests.
- `file://…` → PGlite persisted to disk.
- `postgres://…` → `pg.Pool`. Supabase in production.

Identical SQL migrations run against both, so there is no dialect fork. Tests run
against real Postgres semantics with a fresh isolated database per test file and
no mocked SQL — the determinism claims here are largely SQL-level claims, and
mocking the database would mock away the thing under test.

`query` and `exec` are separate because PGlite's extended protocol rejects
multi-statement SQL (`cannot insert multiple commands into a prepared
statement`). Migrations are multi-statement scripts, so they need the simple
protocol. This was found by a failing test, not anticipated.

## Schema decisions

**`completed_at_iff_completed`** is a table CHECK constraint:

```sql
(status = 'completed' AND completed_at IS NOT NULL) OR
(status <> 'completed' AND completed_at IS NULL)
```

A completed task with no timestamp, or an open task carrying a completion
timestamp, is not merely discouraged — it is unrepresentable. Reporting can trust
`completed_at` without defensive checks.

**`list_id` is nullable and unpopulated in Phase 1.** Seeding lists named "Open"
and "Waiting / Blocked" would store the same fact as `status`. Two records of one
fact eventually disagree, with nothing to say which is right. `status` is the
single source of truth; the column and the seeded lists exist for the Personal
sub-domains (Body, Spiritual, Money, Music, …) in Phase 2.

**`assignee_id` is a Slack user ID string**, not a foreign key to a users table.
A user-sync subsystem is not worth building for a system whose default assignee
is one environment variable. Nullable — 7 of the 21 tasks in the Workast export
have no assignee.

**`task_events` is append-only** (`created` / `completed` / `reopened` / `moved`,
with actor and source). Completed tasks are retained permanently; nothing in
Phase 1 deletes a task. This is what makes completion reporting, weekly
summaries, and stale-task reporting possible without mutable history.

## `slack_cards`: why the group diff exists

```sql
slack_cards (channel_id, message_ts, task_ids[], rendered_state jsonb)
```

A checkbox group's interaction payload contains the group's *currently selected*
options — not which one changed. With ten tasks in one element, "task 3 is
selected" is indistinguishable from "task 3 was just checked."

The obvious approach is to reconcile the whole group: set each task's status to
match the payload. It is wrong. If someone's Slack client holds a stale view —
they had the message open before another completion landed — their next click
submits a selection set that omits the newly-completed task, and whole-group
reconciliation would silently *reopen* it. One person's click would quietly undo
another's work.

So the card records what was actually drawn. Diffing the payload against
`rendered_state` identifies exactly which checkbox moved, normally exactly one,
and only that transition is applied. Every other task is left alone regardless of
what the payload implies. Two tests cover this: one checks a stale sibling is not
re-stamped, another that unchecking one task in a completed pair reopens only
that one.

The table earns its keep twice: it also lets an API- or Hermes-driven mutation
re-render the originating Slack message.

## Idempotency, in two independent layers

They fail differently, so both are needed.

1. **Transitions are idempotent by construction.**
   `UPDATE tasks SET status='completed' WHERE id=$1 AND status<>'completed'`,
   then read back and redraw unconditionally. A duplicate click converges on the
   same state and preserves the original `completed_at`.

2. **`processed_interactions`** has a primary key on
   `(channel_id, message_ts, action_ts)`. Slack retries deliveries it thinks went
   unacknowledged; the insert conflicts and the transition is skipped.

Layer 1 alone keeps task state correct but writes a second `completed` audit row
per retry. Layer 2 keeps the audit log clean. A duplicate still redraws the card,
so the user sees correct state rather than a silently dropped click.

## Slack constraints that shaped the UI

Verified against `docs.slack.dev` and the `@slack/types` source rather than
assumed:

| Constraint | Consequence |
|---|---|
| `checkboxes` work in **messages**, not just modals | the whole design is viable |
| max **10 options** per element | list views chunk into multiple elements |
| `option.text` max **75 chars** | title label budget is 72 + ellipsis |
| `option.text` may be `mrkdwn` for checkboxes/radio only | `~strikethrough~` works |
| `option.description` is `plain_text` only, max 75 | meta line is unformatted |
| `option.value` max 75 | value carries the bare UUID (36) and nothing else |
| deselect-all sends `[]`, not `null` | uncheck is an unambiguous signal |
| `initial_options` must **exactly match** an `options` entry | see below |

**The `initial_options` trap.** On a completed card the strikethrough title must
appear identically in both arrays. Differ by one character and Slack fails to
match them, rendering a **completed task as unchecked** — silent and very
confusing. The renderer therefore builds each option object exactly once and puts
that same reference in both arrays. A test asserts object identity (`toBe`, not
`toEqual`), because structural equality would pass while the bug was live.

**Title rendering by state.** Open labels use `plain_text` so `* _ ~` and
backticks stay literal. Completed labels must use `mrkdwn` for strikethrough,
with `verbatim: true` so URLs, `@mentions`, and `#channels` inside a title are
not rewritten into links. Residual exposure is those four characters on completed
tasks only; no title in the current export contains them. Storage, REST, and MCP
always return the byte-exact title regardless of rendering.

**Truncation counts code points.** `[...title].slice(0, 72)`, never
`title.slice(0, 72)` — JS strings are UTF-16 and a naive slice can split a
surrogate pair and corrupt a character. The export contains `’` and `—`, and a
task title could contain an emoji. Truncation is display-only, never written
back, and when it fires a context block carries the full exact title. The longest
real title today is 63 characters, so this is a safety net rather than a common
path.

**Where selections are read from.** The docs are inconsistent: the state payload
documents `selected_options`, while the checkboxes reference example shows
`options`. The handler reads `state.values[block][action].selected_options`
first — the documented location — then falls back to `action.selected_options`
and `action.options`. All three shapes are tested, as is the empty-array case,
which must be read as a genuine deselect-all rather than missing data.

## Transport

Socket Mode by default: no public URL or tunnel for local development, and
authentication is via the app-level token. `SLACK_MODE=http` switches to an HTTP
receiver; `verifySlackSignature` implements the v0 HMAC scheme with a
five-minute replay window and a constant-time comparison, unit-tested against
tampered bodies, wrong secrets, stale and future timestamps, and malformed
signatures.

## Authorization

`team_id` must equal `SLACK_TEAM_ID`, plus an optional
`AUTHORIZED_SLACK_USER_IDS` allowlist. It **fails closed**: an unconfigured
`SLACK_TEAM_ID` rejects everything rather than accepting every workspace. The
check runs before any database write, so a rejection performs zero mutation and
sends no `chat.update`. Malformed task IDs are rejected by UUID parse before any
query is issued.
