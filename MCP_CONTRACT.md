# Hermes Contract

Hermes is the intelligence layer. This service is the system of record. Exact task
data is authoritative here, and Hermes reads it rather than restating it.

Two transports over identical `task-core` calls, so they cannot drift:

- **MCP** — `pnpm mcp`, stdio. Eight tools.
- **REST** — `pnpm api`, `:3030`, `Authorization: Bearer $API_TOKEN`.

## What Hermes may and may not do

| May | May not |
|---|---|
| read tasks | silently rename a task |
| select priorities | combine tasks |
| summarize workload | split tasks |
| create tasks when explicitly asked | rewrite task titles |
| complete tasks when explicitly authorized | infer completion |
| move tasks when explicitly instructed | infer destructive changes |

The "may not" column is not a policy Hermes is trusted to follow. **No tool or
route accepts a title for an existing task.** `move_task` reads exactly
`task_id`, `space_id`, `status`, and `waiting_on`; a `title` field passed
alongside them is never read. There is no `update_task`, no `rename_task`, no
`set_title`.

`create_task` takes a title and stores it byte-exact. Its description instructs:
*"The title is stored exactly as given and can never be changed afterwards. Do
not summarize, rewrite, combine, or split what the user said — pass their words
through verbatim."*

## MCP tools

| Tool | Required | Optional | Returns |
|---|---|---|---|
| `list_tasks` | — | `space_id`, `assignee_id`, `status`, `actionable_only`, `limit` | `{ tasks }` |
| `get_task` | `task_id` | — | `{ task }` |
| `create_task` | `title`, `space_id` | `assignee_id`, `due_at`, `details` | `{ task }` |
| `complete_task` | `task_id` | — | `{ task }` |
| `move_task` | `task_id` | `space_id`, `status`, `waiting_on` | `{ task }` |

`details` is write-once, like `title`: settable at create, returned on reads, and
changeable by nothing. A `details` key on a `move_task` call is ignored.
| `list_spaces` | — | — | `{ spaces }` |
| `list_waiting` | — | `space_id` | `{ tasks }` |
| `get_task_counts` | — | `assignee_id` | `{ counts }` |

## Channel-aware tools

Hermes never needs internal Space IDs. Pass the Slack channel ID and the service
resolves **channel → canonical Space → exact task operation** from the
database-backed mapping.

| Tool | Required | Optional | Returns |
|---|---|---|---|
| `get_space_for_channel` | `channel_id` | — | `{ space, mapped, channel_name }` |
| `list_tasks_for_context` | `channel_id` | `space`, `include_waiting`, `status`, `limit` | `{ space, resolved_from, tasks }` |
| `create_task_for_context` | `channel_id`, `title` | `space`, `due_at`, `assignee_id`, `details` | `{ task, space, resolved_from }` |

Use these for natural-language requests arriving from a channel:

| User says, in `#client-secure-logic` | Tool |
|---|---|
| "show my tasks" / "what's open?" | `list_tasks_for_context('C_SECURE')` |
| "create a task to update the contact form" | `create_task_for_context('C_SECURE', 'update the contact form')` |
| "create a task for Agency / Internal to review pricing" | `create_task_for_context('C_SECURE', 'review pricing', space: 'Agency / Internal')` |

### Destination precedence

```
explicit space  >  channel mapping  >  Inbox
```

`resolved_from` on every response says which applied — `explicit`, `channel`, or
`inbox` — so Hermes can tell the user where the task actually landed.

**An unresolvable explicit destination is rejected, not redirected.** It raises
`Unknown space: "…"` listing every valid Space, and creates nothing. It
deliberately does not fall back to the channel mapping: silently filing a task
somewhere other than where the user said is the failure this service exists to
prevent. Retry with a name from the `available` list.

A Space may be named by canonical name, slug, name without the `Client - `
prefix, or a configured alias (`Personal tasks` → `Personal`) — each an exact
match after one fixed normalization. Partial names like `secure` are refused.

**Do not resolve channels yourself.** Do not keep your own channel table, and do
not infer a client from a channel's name or a message's text. Call
`get_space_for_channel`; the mapping is configuration, and it changes without
telling you.

`status` is one of `open` | `waiting` | `completed`. `actionable_only: true`
returns open tasks only — waiting and completed are both excluded, which is the
right default for daily priorities.

`complete_task` is idempotent: calling it on a completed task returns the task
with its original `completed_at` unchanged.

Errors: a malformed `task_id` throws before any query is issued; an unknown but
well-formed id throws `TaskNotFoundError`.

### Registering with Hermes

```json
{
  "mcpServers": {
    "team-riley-tasks": {
      "command": "pnpm",
      "args": ["--dir", "/Users/joshuariley/Sites/slack-todo-app", "mcp"],
      "env": { "DATABASE_URL": "" }
    }
  }
}
```

Point `DATABASE_URL` at the same database the Slack app uses, or Hermes will read
an empty database of its own.

## Task shape

```jsonc
{
  "id": "uuid",
  "title": "Offer Neil Instagram and Facebook package for $100",  // byte-exact
  "space_id": "uuid",
  "list_id": null,              // unpopulated in Phase 1; status is authoritative
  "assignee_id": "U…" ,         // Slack user ID, nullable
  "status": "open",             // open | waiting | completed
  "due_at": null,               // timestamptz
  "waiting_on": null,           // free text, nullable, only meaningful when waiting
  "details": null,              // capture notes; write-once, no update path
  "created_at": "…",
  "completed_at": null,         // non-null iff status is completed
  "source_platform": "slack",   // slack | api | hermes | workast
  "source_channel_id": "C…",
  "source_message_ts": "…",
  "created_by": "U…"
}
```

`completed_at` is non-null exactly when `status` is `completed`, guaranteed by a
database constraint rather than convention.

## REST routes

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | |
| GET | `/spaces` | |
| GET | `/tasks` | `?space_id=&assignee_id=&status=&actionable=true&limit=` |
| GET | `/tasks/:id` | 400 on malformed id, 404 on unknown |
| GET | `/waiting` | `?space_id=` |
| GET | `/counts` | `?assignee_id=` |
| POST | `/tasks` | `{ title, space_id, assignee_id?, due_at? }` → 201 |
| POST | `/tasks/:id/complete` | idempotent |
| POST | `/tasks/:id/reopen` | idempotent |
| POST | `/tasks/:id/move` | `{ space_id?, status?, waiting_on? }` |
| GET | `/channel-map` | current channel → Space mapping |
| GET | `/context/:channelId/space` | `{ space, mapped, channel_name }` |
| GET | `/context/:channelId/tasks` | `?space=&include_waiting=true&status=&limit=` |
| POST | `/context/:channelId/tasks` | `{ title, space?, due_at?, assignee_id? }` → 201 |

An unknown explicit `space` returns **400** `{ error: "unknown_space", requested,
available }`.

There is deliberately no `PATCH /tasks/:id` or `PUT /tasks/:id`. Pass
`X-Actor-Id` to attribute an audit event to a person.

A missing `API_TOKEN` returns 503 rather than serving unauthenticated requests.

## Reports Hermes can build from this

- **TOP PRIORITIES** — `list_tasks({ actionable_only: true })`, ordered by
  `due_at` then `created_at`; Hermes selects and ranks.
- **WAITING / BLOCKED** — `list_waiting()`, with `waiting_on` where recorded.
- **CLIENT OPEN TASKS** — `get_task_counts()`, or `list_tasks({ space_id })` per
  client space.
- **FOLLOW-UPS / COMMITMENTS** — `list_tasks` filtered on `due_at`, plus the
  `task_events` audit trail for staleness.

Hermes composes the narrative. It quotes titles exactly as returned.

## Daily Anchors

Meditate, Exercise, Journal, Cold Exposure, and Vocal Warm-Ups are **not** in
this system. They remain external with their own Google Sheet tracking. A future
integration may display them next to Personal tasks without changing their
storage model. Do not create them as tasks here.
