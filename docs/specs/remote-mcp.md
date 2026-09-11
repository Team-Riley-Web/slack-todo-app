# Remote MCP over authenticated HTTPS — spec as given, 2026-09-11

Captured verbatim from the request so the `TASKS.md` entry stays one line.
Nothing here is inferred.

## Goal

Keep stdio support for local development/testing, but ALSO expose the same MCP
tools through a production remote MCP endpoint using MCP Streamable HTTP.

Production shape: `https://<TASKS_APP_HOST>/mcp`

Hermes Managed should connect remotely without cloning or running the Tasks
repo inside the Hermes container.

## Read first — do not guess tool names

`MCP_CONTRACT.md`, `packages/mcp/src/index.ts`, `packages/mcp/src/tools.ts`,
`packages/mcp/src/tools.test.ts`, `tests/determinism.test.ts`.

**Do not redesign the MCP contract yet.** Report and preserve the ACTUAL
existing eight-tool contract.

## Transport

Use the official MCP SDK's supported Streamable HTTP transport. Do not create a
proprietary pseudo-MCP REST endpoint. Reuse the exact same tool definitions the
stdio server uses — there must not be separate stdio and HTTP business logic.

Preferred structure (or the closest clean fit with the current codebase):

```
packages/mcp/
  tools.ts   → canonical tool definitions
  server.ts  → constructs/registers the MCP server
  stdio.ts (or existing index.ts) → stdio transport
  http.ts    → Streamable HTTP transport
```

Both transports must expose the same contract.

## Authentication

Protect the remote endpoint. Add `TASKS_MCP_TOKEN` and require
`Authorization: Bearer <token>`.

The token must never appear in URLs, source control, logs, browser bundles, or
tool responses. Use timing-safe comparison if appropriate. Return unauthorized
responses without leaking credential detail.

The REST API's `API_TOKEN` and the MCP token may remain separate — prefer
separate credentials so MCP access can be revoked independently.

## Security posture

Preserve the fundamental rule: **AI can read tasks; it cannot rewrite what you
wrote.**

- Do not expose `editTask`.
- Do not expose any tool that can rename an existing task.
- Do not weaken the existing determinism tests.

Preserve: UUID-only mutation targeting; no fuzzy title matching for mutation;
exact-title creation; explicit Space resolution; `create_task_for_context`
channel mapping behavior; unknown Space failing rather than falling back to a
guess.

If the eight-tool contract includes mutations, preserve only those already
explicitly documented/tested. **Do not add a generic `update_task` tool merely
because another specification once mentioned it.**

## Channel-aware Hermes usage

Preserve `create_task_for_context` so Hermes can submit `channel_id`, `title`,
and an optional explicit Space. The Tasks app remains responsible for
channel ID → canonical Space → task creation; Hermes must not maintain a
competing routing table. The result must keep exposing whether resolution came
from `channel` or an explicit override.

## Read access for Hermes

Confirm the existing contract gives Hermes enough read capability for: agency
executive briefings, client task summaries, open-task counts, waiting/blocked
summaries, Personal one-time-task context, priority-aware analysis.

Do not add tools until MCP_CONTRACT.md has been read. If the existing eight do
NOT suffice, report the exact gap and propose the smallest addition separately.
**Do not silently expand scope.**

## Priority

If the task model now includes P0/P1/P2/P3/null, ensure MCP task
representations expose priority. Do not create a second priority
interpretation inside MCP — use the canonical task-core model.

## Deployment

Integrate `/mcp` into the existing Tasks app deployment in the simplest
supported way. Do not create another standalone infrastructure service if the
existing API deployment can safely host it. If hosting `/mcp` inside `apps/api`
is architecturally clean, prefer that.

**If MCP Streamable HTTP requires a long-lived server/runtime incompatible with
the current hosting platform, report that before implementing a workaround. Do
not emulate long-lived MCP behavior on an incompatible serverless platform.**

## Health / discovery

Provide a safe way to verify the remote MCP service is alive without exposing
task data or credentials. Reuse existing service health infrastructure if
appropriate. No secrets in health output.

## Tests required

1. stdio and HTTP expose the same MCP tool names
2. HTTP MCP rejects missing Authorization
3. HTTP MCP rejects invalid bearer token
4. valid bearer token initializes MCP correctly
5. existing read tools work over HTTP transport
6. `create_task` preserves exact title
7. `create_task_for_context` preserves channel routing semantics
8. unknown explicit Space still fails
9. existing task title cannot be edited through MCP
10. UUID-only mutation protections remain
11. no fuzzy mutation lookup is introduced
12. MCP responses include canonical priority if supported
13. stdio behavior remains unchanged
14. scheduled task delivery still has zero MCP/Hermes dependency

## Documentation

Update `MCP_CONTRACT.md` with: stdio development usage, remote HTTPS MCP usage,
authentication requirement, production endpoint configuration, the exact
existing tool list, mutation limitations, Hermes security contract. Do not
document secret values.

Add an EMPTY `TASKS_MCP_TOKEN=` to `.env.example`.

## Report back with

1. exact existing eight MCP tools from MCP_CONTRACT.md
2. files changed
3. remote MCP endpoint path
4. transport used
5. authentication mechanism
6. environment variable required
7. confirmation stdio remains supported
8. confirmation editTask/title mutation remains inaccessible
9. confirmation channel-aware creation remains supported
10. read capabilities Hermes will have
11. tests/results
12. deployment compatibility
13. exact production URL pattern Hermes should be given
14. any blocker before connecting Hermes
