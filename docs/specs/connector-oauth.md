# Claude / ChatGPT connector — OAuth sign-in and batch create

Written 2026-10-06. Goal as given: talk through everything on your plate, say
**"create the todo list for me"**, read the proposed list, then say **"create
tasks"** and have them saved to the right Spaces.

## What already exists (do not rebuild)

- Remote MCP at `/mcp` (`apps/web/src/app/mcp/route.ts` → `packages/mcp/src/http.ts`),
  Streamable HTTP, stateless, 20 tools. Live in production.
- `list_spaces`, `create_task`, `create_task_for_context` — Space resolution is
  exact-or-reject, titles stored byte-exact, priority settable at creation.
- Auth today: one static `Authorization: Bearer $TASKS_MCP_TOKEN`, used by Hermes.
- Web sign-in: Auth.js with Slack, JWT sessions, `authorizeSlackUser` allowlist
  (`AUTHORIZED_SLACK_USER_IDS`, fails closed).

## Gap 1 — sign-in the apps can use

Claude.ai and ChatGPT custom connectors take a URL plus optional OAuth. They
have no field for a static bearer header. "No auth" is rejected: anyone with the
URL could create or complete tasks.

**Verify against each product's current docs before building** — exact
requirements (DCR vs. static client, redirect URIs, required metadata) change.

### Design: single-user OAuth 2.1, stateless

The MCP server is its own authorization server, and the human step reuses the
existing Slack sign-in. No new database table.

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource` | RFC 9728. Names `/mcp` as the resource and the authorization server. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata: endpoints, `S256` only, grant types. |
| `POST /oauth/register` | RFC 7591 dynamic client registration. |
| `GET /oauth/authorize` | Needs an Auth.js session. No session → Slack sign-in → back. Not on the allowlist → refuse. Otherwise a consent page ("Connect <client> to your tasks?"), Approve → redirect with code. |
| `POST /oauth/token` | `authorization_code` (PKCE required) and `refresh_token`. |

**Stateless tokens.** `client_id`, authorization code, access token and refresh
token are all HMAC-signed blobs (secret `MCP_OAUTH_SECRET`), carrying only what
they need: redirect URIs, PKCE challenge, Slack user id, expiry. Lifetimes:
code 60s, access 1h, refresh 90d.

- **Revocation:** every `/mcp` request re-checks the Slack user id against
  `AUTHORIZED_SLACK_USER_IDS` (same as the web app, so removing an id cuts access
  immediately). Rotating `MCP_OAUTH_SECRET` signs out every connector at once.
- **Known limit:** a stateless code cannot be marked single-use. PKCE plus a 60s
  lifetime bounds this. If that is not acceptable, add an `oauth_codes` table —
  say so before implementation.
- **Redirect URIs:** only `https` URIs on an allowlist of known connector hosts
  (confirm the exact hosts from current docs). Exact-match, no wildcards.

**`/mcp` accepts either credential.** The static `TASKS_MCP_TOKEN` keeps working
for Hermes. An OAuth access token works for the connectors. Both reach the same
`createMcpServer`, so the tool list is identical. A 401 carries
`WWW-Authenticate: Bearer resource_metadata="…"` so clients can discover the
flow. Existing "401 leaks nothing" behaviour is unchanged.

**Code placement.** Token signing/verification and metadata live in `packages/mcp`
(`oauth.ts`), because `src/no-secrets.test.ts` forbids `apps/web/src/app` from
reading credentials. Route files stay thin adapters; the only app-level piece is
the callback that returns the current Auth.js user to the authorize handler.

## Gap 2 — batch create

New tool **`create_tasks`**, so approving a list is one confirmation.

- Input: `tasks[]`, max 25. Each: `title`, one of `space` (name/alias, same
  resolver as `create_task_for_context`) or `space_id`, optional `priority`,
  `due_at`, `details`, `assignee_id`.
- **All-or-nothing:** resolve and validate every item first; any unknown Space or
  invalid priority rejects the whole batch with the list of valid Spaces and
  creates nothing. Then insert in one transaction.
- Reuses the single-task create path, so title exactness and priority validation
  cannot drift. Returns `{ tasks: [{ task, space, resolved_from }] }`.
- Tool description: *"Only call after the user has seen the full list and said to
  create it. Pass the approved titles exactly as shown."* The two-step flow lives
  in the description, not in a separate "propose" tool — the proposal is the
  assistant's chat reply.
- Counts as a sixth write tool; `MCP_CONTRACT.md` and the `TOOL_NAMES` test
  (21 tools) update with it. No tool gains the ability to edit a title.

## Tests

1. Metadata documents are well-formed and point at the right URLs.
2. `register` rejects non-https and non-allowlisted redirect URIs.
3. `authorize` without a session redirects to sign-in; with a non-allowlisted
   user refuses; with an allowed user issues a code bound to the PKCE challenge.
4. `token` rejects a wrong verifier, an expired code, a tampered code, a
   mismatched redirect URI.
5. Access token reaches `/mcp`; expired/tampered/wrong-secret does not (401, no
   detail). Removing the user from the allowlist revokes an already-issued token.
6. Static `TASKS_MCP_TOKEN` still works; unset secrets deny everything.
7. `create_tasks`: happy path, exact titles, mixed Spaces, one bad Space creates
   nothing, over-25 rejected, invalid priority rejects the batch.
8. stdio and HTTP still list the same tool names; `no-secrets` test still passes.

## Steps

1. `create_tasks` + tests + `MCP_CONTRACT.md` (independent of OAuth; usable at
   once from Claude Code with `claude mcp add --transport http`).
2. OAuth module in `packages/mcp` + tests.
3. Thin routes in `apps/web` + consent page.
4. Add `MCP_OAUTH_SECRET=` to `.env.example`; set it in Vercel.
5. Deploy (see open decisions), then connect in Claude → test the full
   "create the todo list" / "create tasks" flow → then ChatGPT.

## Open decisions

- **Deploy method.** Issue #7 says pushes to `master` do not deploy (Hobby plan +
  org-owned private repo); deploys are CLI-only (`vercel --prod`). That conflicts
  with the standing "deploy is git push, never `vercel --prod`" rule. Needs your
  call before step 5.
- **Single-use codes:** stateless (recommended) or add a table.
- **Plans:** confirm your Claude and ChatGPT plans allow custom connectors
  (ChatGPT needs Developer Mode).
