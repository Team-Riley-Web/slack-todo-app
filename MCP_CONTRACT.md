# Hermes Contract

Hermes is the intelligence layer. This service is the system of record. Exact task
data is authoritative here, and Hermes reads it rather than restating it.

Three transports over identical `task-core` calls, so they cannot drift:

- **MCP over stdio** — `pnpm mcp`. Local development and testing.
- **MCP over HTTPS** — `https://<host>/mcp`, `Authorization: Bearer $TASKS_MCP_TOKEN`.
  What Hermes Managed connects to.
- **REST** — `pnpm api`, `:3030`, `Authorization: Bearer $API_TOKEN`.

Twenty-one tools, listed in full below. (An earlier version of this line said
"eight"; it was stale from the first phase and never matched `TOOL_NAMES`.)

## Connecting Hermes

```text
https://<TASKS_APP_HOST>/mcp
Authorization: Bearer <TASKS_MCP_TOKEN>
```

Liveness, unauthenticated and carrying no task data:

```sh
curl https://<TASKS_APP_HOST>/mcp/health
# {"ok":true,"service":"team-riley-tasks-mcp","transport":"streamable-http",
#  "tools":21,"configured":true}
```

`configured` says only that a token EXISTS, never what it is. 503 when unset.

### Transport

The MCP SDK's own Streamable HTTP transport
(`WebStandardStreamableHTTPServerTransport`), in **stateless** mode —
`sessionIdGenerator: undefined`, `enableJsonResponse: true`. A fresh server and
transport per request, nothing retained between them, no session affinity. This
is the SDK's documented shape for a serverless host, not an emulation of one:
the endpoint lives in the Next.js app, which is the only deployed surface this
system has, and a serverless invocation ends when it returns its response, so
an SSE stream it is supposed to keep feeding is a stream nobody can serve.

`apps/api` deliberately does NOT host it. That app has no deployment of any
kind — no Dockerfile, no platform config; it runs locally on :3030 — so an
endpoint there would have no public host for Hermes to reach.

### Authentication

`TASKS_MCP_TOKEN`, as `Authorization: Bearer <token>`. Compared in constant
time. A missing or wrong token gets `401 {"error":"unauthorized"}` and nothing
else: no hint whether the token was absent, the wrong length, or merely wrong,
and no echo of what was sent. An UNSET token denies every request, so a deploy
that forgot to configure it is closed rather than open. The database is not
touched until a request has authenticated.

It is deliberately separate from the REST API's `API_TOKEN`, so Hermes's MCP
access can be revoked without taking the REST API down with it.

### Connector sign-in (Claude.ai, ChatGPT)

The custom-connector screens take a URL and OAuth, not a bearer header, so
`/mcp` also accepts an OAuth access token. Same endpoint, same twenty-one tools.
Design and trade-offs: `docs/specs/connector-oauth.md`.

Add the connector with just `https://<TASKS_APP_HOST>/mcp`. The app is its own
authorization server (OAuth 2.1, PKCE `S256` only, dynamic client registration)
and the human step is the web app's existing **Sign in with Slack**, limited to
`AUTHORIZED_SLACK_USER_IDS`. A consent screen names what is being connected.

| Path | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource[/mcp]` | RFC 9728 discovery |
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata |
| `/oauth/register` | dynamic client registration |
| `/oauth/authorize` | sign-in redirect, consent, code |
| `/oauth/token` | code and refresh-token exchange |

- **Configuration:** `MCP_OAUTH_SECRET` (32+ characters). Unset or shorter, the
  sign-in is off and `/mcp` accepts only `TASKS_MCP_TOKEN`. `/mcp/health` reports
  `oauth: true|false`, never the secret.
- **Stateless:** clients, codes and tokens are HMAC-signed, nothing is stored.
  Access tokens last 1 hour, refresh tokens 90 days, codes 60 seconds.
- **Revoking:** remove the person from `AUTHORIZED_SLACK_USER_IDS` and every
  token they hold stops working on its next request. Rotating
  `MCP_OAUTH_SECRET` signs out every connector at once.
- **Redirect addresses** are an exact allowlist: `claude.ai` / `claude.com`
  `/api/mcp/auth_callback`, ChatGPT's `/connector/oauth/<id>` and
  `/connector_platform_oauth_redirect`, and loopback for local clients like
  Claude Code. Anything else is refused at registration and again at
  authorization.
- **Known limit:** a code cannot be marked single-use without storing it. PKCE
  and the 60-second lifetime bound that.
- The Hermes bearer token is unchanged and independent.

### Development

`pnpm mcp` still runs the stdio transport, unchanged. Both transports are
built by the same `createMcpServer`, so a tool cannot exist on one and not the
other — `packages/mcp/src/http.test.ts` asserts the two name lists are equal.

### What remote access does NOT add

Exposing the tools over HTTPS changes the reach, not the contract. There is
still no tool that can rename or re-prioritise an existing task, mutations
still take UUIDs only, an unknown explicit Space is still rejected rather than
guessed at, and `create_task_for_context` still reports whether the
destination came from the `channel` or an `explicit` override.

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
| `create_task` | `title`, `space_id` | `assignee_id`, `due_at`, `details`, `priority` | `{ task }` |
| `create_tasks` | `tasks[]` (max 25; each `title` + `space` or `space_id`) | per task: `due_at`, `assignee_id`, `details`, `priority` | `{ tasks: [{ task, space }] }` |
| `complete_task` | `task_id` | — | `{ task }` |
| `move_task` | `task_id` | `space_id`, `status`, `waiting_on` | `{ task }` |

| `set_task_details` | `task_id`, `details` | — | `{ task }` |

### Batch create

`create_tasks` takes up to 25 tasks so one approval covers a whole list. Every
task names its Space explicitly (`space` or `space_id`) — there is no Inbox
fallback and no guessing. It is **all-or-nothing**: any unknown Space, invalid
priority or empty title rejects the batch, names the offending `tasks[i]`, and
creates nothing, so a retry cannot duplicate the earlier items. Titles follow
the same rule as `create_task`. The intended flow is conversational: the
assistant proposes the list in chat, the user approves, then it calls this once.

### Priority

Every task carries `priority`: `P0`, `P1`, `P2`, `P3`, or `null` for
unprioritized. It is part of the canonical task-core model, so it appears on
every task these tools return without any MCP-side interpretation.

It may be **set at creation** (`create_task`, `create_task_for_context`) and
never afterwards — the same rule the title follows. There is no
`set_priority`, and `move_task` does not read one. An invalid value is
rejected rather than stored as `null`: a mistyped `P7` silently becoming
"unprioritized" would be indistinguishable from a task nobody prioritised.

Omitting it is always valid, so a caller written before priority existed keeps
working unchanged.

Every list is ordered priority first (`P0 → P1 → P2 → P3 → unprioritized`),
then due date, then creation — the same ordering Slack, the web UI and the
scheduled digests use, because they all share one query.

`details` (a task's notes) IS updatable via `set_task_details`; `title` is not.
That tool reads only `task_id` and `details`, so it can never become a route to
the title. Pass `null` to clear. A `details` key on a `move_task` call is still
ignored — `move_task` reads only space, status, and waiting_on.
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
| `create_task_for_context` | `channel_id`, `title` | `space`, `due_at`, `assignee_id`, `details`, `priority` | `{ task, space, resolved_from }` |

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

## Import inspection — read only

| Tool | Required | Optional | Returns |
|---|---|---|---|
| `list_import_batches` | — | `limit` | `{ batches }` |
| `get_import_batch` | `batch_id` | — | `{ batch, counts, audit }` |
| `preview_import` | `batch_id` | `verdict` | `{ rows, counts }` |
| `get_import_conflicts` | `batch_id` | — | `{ conflicts }` |

Hermes may inspect batches, explain why rows conflict, and suggest mappings. It
may **not** confirm, import, roll back, or merge. `preview_import` takes a
`batch_id` and its schema has no file field at all — parsing and staging happen
through the CLI, never here.

A test seeds a `CONFIRMED` batch, calls all four tools, and asserts the task
count is still zero and the batch state never advanced. That is the guarantee,
not this paragraph. Full detail in `IMPORT.md`.

## Reporting — read only

| Tool | Required | Optional | Returns |
|---|---|---|---|
| `get_open_counts_by_space` | — | — | `{ counts }` |
| `get_completed_between` | `from`, `to` | `space_id` | `{ tasks }` |
| `get_this_week` | — | — | `{ created, completed }` |
| `get_task_health` | — | `stale_after_days`, `space_id` | `{ average_age_days, stale }` |

Three semantics worth relying on:

- `get_completed_between` is **half-open**: `from` inclusive, `to` exclusive, so
  two abutting ranges never double-count the same task.
- `average_age_days` counts **open tasks only**. Including completed ones would
  make the number drift down as work gets finished, which is backwards.
- `stale` excludes **waiting** tasks. They are parked deliberately, and counting
  them as neglected would bury the ones that actually are.

The week starts Monday 00:00 UTC.

Twenty-one tools in total, on both transports. Six can write — `create_task`,
`create_tasks`, `create_task_for_context`, `complete_task`, `move_task`, `set_task_details` —
and none of them can touch a title.

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
  "details": null,              // notes; updatable via set_task_details, unlike title
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
| POST | `/tasks/:id/details` | `{ details }` — string or null; cannot touch the title |
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
