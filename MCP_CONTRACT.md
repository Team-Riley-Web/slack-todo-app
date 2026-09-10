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
| `create_task` | `title`, `space_id` | `assignee_id`, `due_at` | `{ task }` |
| `complete_task` | `task_id` | — | `{ task }` |
| `move_task` | `task_id` | `space_id`, `status`, `waiting_on` | `{ task }` |
| `list_spaces` | — | — | `{ spaces }` |
| `list_waiting` | — | `space_id` | `{ tasks }` |
| `get_task_counts` | — | `assignee_id` | `{ counts }` |

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
