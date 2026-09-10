# Slack-Native Task Manager — Phase 1 Design

Date: 2026-09-09
Status: Approved
Scope: Phase 1 only

## 1. Core principle

AI is not in the task mutation path. Task capture and task state are deterministic.

`/task Offer Neil Instagram and Facebook package for $100` stores the title
`Offer Neil Instagram and Facebook package for $100` — byte for byte.

This is enforced structurally, not by validation. `packages/task-core` is the only
code permitted to mutate a task, and it exposes no function that can change a title:

```
createTask({ title })  → stores title verbatim, write-once
completeTask({ id })   → status + completed_at only
reopenTask({ id })     → status + completed_at only
moveTask({ id, ... })  → space + list + status only
```

There is no `updateTitle` in Phase 1. Hermes cannot rename a task because the
capability does not exist to call, not because a guard rejects the attempt.
`apps/slack`, `apps/api`, and `packages/mcp` are thin adapters: parse, authorize,
call core, render. They never issue SQL.

## 2. Verified Slack platform facts

Confirmed against docs.slack.dev and the `@slack/types` source, not assumed:

| Fact | Source | Consequence |
|---|---|---|
| `checkboxes` supported in **Messages**, Modals, Home tabs | checkboxes-element reference | Native checkbox task card is viable |
| Supported in `section`, `actions`, `input` blocks | same | `actions` block gives left-side checkbox |
| Max **10 options** per element | same | List views group ≤10 tasks per element |
| `option.text` may be **mrkdwn** for checkboxes/radio | `@slack/types` `MrkdwnOption` | `~strikethrough~` works in the label |
| `option.text` max **75 chars** | `@slack/types` `MrkdwnOption` | Effective title budget is 73 (`~`+73+`~`) |
| `option.description` is **plain_text only**, max 75 | `@slack/types` `OptionDescriptor` | Meta line is unformatted, needs compaction |
| `option.value` max 75 | `@slack/types` `OptionDescriptor` | Value carries the bare UUID (36) and nothing else |
| Deselect-all sends **`[]`**, not `null` | 2020-09-01 changelog | Uncheck is an unambiguous signal |
| `initial_options` must **exactly match** an entry in `options` | `@slack/types` `Checkboxes` | See §4 bug trap |
| `MrkdwnElement.verbatim: true` skips URL/mention/channel parsing | `@slack/types` `MrkdwnElement` | Protects titles containing URLs or `#channel` |

Residual runtime check: strikethrough rendering inside a checkbox label is
specified but only provable against an installed app. The completed card also
states `Completed <date>` in its plain-text meta line, so completion is
unambiguous from the checked box plus that line even if strikethrough failed to
render. Recovery would be one function (`renderTitle`).

## 3. Slack interaction model

The native checkbox is the single task-state control. No Complete button, no
Reopen button, no glyphs imitating checkboxes, no inert completed icon.

```
Open:       [ ] Offer Neil Instagram and Facebook package for $100
                Nazareth Law · Joshua · due Sep 15

Completed:  [x] ~Offer Neil Instagram and Facebook package for $100~
                Completed Sep 9 · Nazareth Law
```

State machine, both directions:

| Transition | Effect |
|---|---|
| unchecked → checked | status=completed, completed_at=now |
| checked → unchecked | status=open, completed_at=NULL (explicit reopen) |
| checked → checked | no-op, redraw |
| unchecked → unchecked | no-op, redraw |

### Title rendering

| State | Text type | Rationale |
|---|---|---|
| Open | `plain_text`, `emoji: true` | `* _ ~ \`` render literally; plain_text never linkifies |
| Completed | `mrkdwn`, `verbatim: true` | strikethrough requires mrkdwn; verbatim protects URLs/mentions |

Residual exposure: `*`, `_`, `~`, and backtick may render as formatting on
completed tasks only. Zero titles in the current Workast export contain them.
Storage, REST, and MCP always return the byte-exact title regardless of rendering.

### Truncation rule

Titles are never truncated in storage. The checkbox *label* is capped by Slack at
75 chars, and `~…~` costs 2, so the label budget is 73.

- Label = title when `[...title].length <= 72`
- Otherwise label = first 72 **code points** + `…` (73 chars; 75 with tildes)
- When truncated, a `context` block beneath carries the full exact title

Truncation counts **code points**, not UTF-16 units — `[...title].slice(0, 72)`,
never `title.slice(0, 72)`. The export contains `’` and `—`, and a naive slice
can split a surrogate pair and corrupt a character. Truncation is display-only
and is never written back. Longest real title today is 63 chars, so this path is
a safety net rather than a common case.

### Meta line compaction

`option.description` is plain_text, max 75 chars. Compaction order when over
budget: drop assignee, then abbreviate the space name (strip `Client - ` prefix),
then truncate by code point. Meta is derived data and is not covered by the
exact-title guarantee.

## 4. The `initial_options` bug trap

On a completed card the strikethrough title must appear **identically** in both
`options` and `initial_options`. If the two differ by even one character, Slack
does not match them and the checkbox renders **unchecked on a completed task** —
a silent, high-confusion failure.

Mitigation: the renderer builds each option object exactly once and places that
same object reference in both arrays. Never construct it twice. This gets a
dedicated test asserting object identity, beyond the 18 required tests.

## 5. Data model

`spaces` · `channel_space_map` · `lists` · `tasks` · `slack_cards` ·
`task_events` · `processed_interactions`

Deviations from a literal reading of the brief, both deliberate:

**`list_id` is nullable and unpopulated in Phase 1.** Seeding lists named "Open"
and "Waiting / Blocked" would store the same fact as `status`, and two records of
one fact eventually disagree with no way to tell which is right. `status` is the
single source of truth. The column and seeded lists exist; they are where the
Personal sub-domains (Body, Spiritual, Money, Music, …) land in Phase 2.

**`assignee_id` is a Slack user ID string**, not a FK to a users table. Avoids a
user-sync subsystem for a system whose default assignee is configured in env.
Nullable — 7 of 21 tasks in the export have no assignee.

`due_at` is `timestamptz`. The export carries date + time + timezone
(`2026-11-13 09:00:00 America/Chicago`), so `due:YYYY-MM-DD` resolves against a
configured `DEFAULT_TIMEZONE`.

`task_events` is append-only (`created`/`completed`/`reopened`/`moved`, actor,
source) and is what makes stale-task and completion reporting possible without
retaining mutable history. Completed tasks are retained permanently.

**`slack_cards (channel_id, message_ts, task_ids[], rendered_state jsonb)`** —
records what was actually drawn. Two jobs:
1. A group toggle's payload contains the group's *currently selected* options, not
   which one changed. Diffing payload against `rendered_state` identifies the
   exact checkbox toggled — normally exactly one — so only that transition is
   applied. Reconciling the whole group instead would let a stale client silently
   revert another user's completion.
2. Lets an API- or Hermes-driven mutation re-render the originating Slack message.

## 6. Due-date parsing

Strict suffix grammar only, consumed from the end of the input:

`due:YYYY-MM-DD` | `due:today` | `due:tomorrow` | `due:mon`…`due:sun`

Anything else is part of the title. No NLP, no inference. If no token matches, the
title is byte-identical to the raw input. When a token matches, it is stripped and
the remainder is byte-exact after a single trailing-space trim.

## 7. Determinism and idempotency

Interaction flow: receive `block_actions` → verify authorized user → resolve exact
task ID from `option.value` → diff against `rendered_state` → apply transition →
read task back → `chat.update` the same message → ACK. No LLM call, no title
matching, no fuzzy lookup.

Two independent idempotency layers, because they fail differently:

1. **Transitions are idempotent by construction** —
   `SET status='completed' WHERE id=$1 AND status<>'completed'`, then read back and
   redraw unconditionally. Duplicate clicks converge on the same state.
2. **`processed_interactions`** with a unique index on
   `(channel_id, message_ts, action_ts)` absorbs Slack's automatic retries.

Layer 1 alone keeps task state correct but double-writes the audit log; layer 2
keeps the log clean.

## 8. Authorization

`team_id` must equal `SLACK_TEAM_ID`; optional `AUTHORIZED_SLACK_USER_IDS`
allowlist. The check runs before any DB write — rejection produces an ephemeral
message and zero mutation. Malformed task IDs are rejected by UUID parse before a
query is issued.

## 9. Spaces and channel mapping

Seeded canonically per the brief: Agency / Internal, Marketing, Sales, Personal,
Client - Joy Within Birth, Client - Secure Logic, Client - CFC Skincare,
Client - Nazareth Law, Client - Milltown Cabinets, Client - Yoga Farm, plus Inbox
as the unmapped-channel fallback.

Channel → Space mapping is deterministic config. An unmapped channel routes to
Inbox and the confirmation says so. Client identity is never inferred from message
text when a channel mapping resolves it.

Two mismatches with the Workast export are recorded in `MIGRATION_PLAN.md` rather
than resolved here: the export has `Music` as a top-level category (the brief
lists Music as a Personal sub-domain) and `Personal tasks` where the brief says
`Personal`.

## 10. Hermes contract

REST (Fastify) and MCP (stdio) are two adapters over identical `task-core` calls,
so they cannot drift: `list_tasks`, `get_task`, `create_task`, `complete_task`,
`move_task`, `list_spaces`, `list_waiting`, `get_task_counts`.

Hermes may read, prioritize, summarize, and — when explicitly instructed — create,
complete, and move. Hermes may not rename, combine, split, infer completion, or
infer destructive change. No title-mutating tool is exposed.

## 11. Storage and runtime

Single `query(sql, params)` interface with two drivers selected by `DATABASE_URL`:
PGlite (embedded Postgres) for dev and tests, `pg.Pool` against Supabase for prod.
Identical SQL migrations run on both; no dialect fork.

A new dedicated Slack app, not a shared one, because: Socket Mode is an app-wide
setting and enabling it on an existing HTTP app changes how that app receives
events; slash commands are a per-app namespace; new scopes force a reinstall; and
a crash here should not take down Hermes' Slack surface.

Socket Mode is the default for local development. An HTTP receiver with request
signature verification is available for deployment, and signature verification is
unit-tested.

## 12. Testing

Vitest against real PGlite, a fresh isolated database per test file, no mocked
SQL — the determinism claims are largely SQL-level claims. Slack is exercised by
feeding recorded `block_actions` fixtures through the real handler with a stubbed
Web API client, asserting on exact `chat.update` arguments.

All 18 required tests map directly. Added beyond them: `initial_options` object
identity (§4), code-point-safe truncation (§3), and display truncation never
written back to storage.

## 13. Deferred to Phase 2

App Home tab (`/tasks` covers the need in Phase 1) · Personal sub-lists · Workast
and Hermes Kanban importers · title editing · due-date editing UI · Daily Anchors
(remain external, Google Sheet tracking unchanged).

Importing Workast `details` (up to 3,224 chars in the export) requires adding a
nullable `details` column. The brief specifies a minimal schema without one, so
Phase 1 does not add it; the consequence is recorded rather than silently
widening the schema.
