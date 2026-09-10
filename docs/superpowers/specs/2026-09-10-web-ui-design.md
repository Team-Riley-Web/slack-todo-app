# Phase 2B Design — Web UI

Date: 2026-09-10
Status: Approved
Scope: Phase 2B. The Slack import wizard follows separately.

## 1. Position

Slack stays the primary interface. The web UI exists for the things a chat
surface is bad at: seeing everything at once, filtering, reviewing completed
history, fixing metadata, and managing mappings.

It is a **fourth adapter** over `task-core`, alongside the Slack app, REST, and
MCP. There is one database and one set of task functions. The web UI holds no
business logic of its own: server code imports `@tr/task-core` directly, so a
button calls the same `completeTask` the Slack checkbox calls. No internal HTTP
hop, no second copy of any rule.

## 2. Platform facts, verified not assumed

| Fact | Source | Consequence |
|---|---|---|
| Slack requires the OAuth redirect URL to use **https, even in local development** | authjs.dev Slack provider | sign-in cannot work on plain `localhost`; see §4 |
| `cookies()` and `headers()` are **async** in the App Router | Next.js docs | every call must be awaited |
| The App Router **transpiles workspace packages automatically** | Next.js `transpilePackages` docs | `transpilePackages` is declared for explicitness, not necessity |
| Auth.js Slack provider reads `AUTH_SLACK_ID` / `AUTH_SLACK_SECRET` | authjs.dev | env names are fixed, not ours to choose |
| The Slack profile's fields are **not documented** by Auth.js | authjs.dev | authorization must not depend on a workspace id being present; see §4 |
| Next.js callback path is `/api/auth/callback/slack` | authjs.dev | the Slack app needs exactly this redirect URL |

## 3. Refactor: `packages/slack-sync`

A web completion must redraw the Slack card it came from, so the card code has
to be reachable from both apps. It currently lives in `apps/slack/src/cards.ts`
plus `redrawCard` in the checkbox handler.

`packages/slack-sync` takes over: `saveCard`, `loadCard`, `baselineFor`,
`claimInteraction`, `withCardLock`, `redrawCard`, and
`syncCardsForTask(deps, taskId)`. Both `apps/slack` and `apps/web` import it, so
there is one copy rather than two that drift. The Slack handlers keep their
current behaviour; this is a move, not a rewrite, and the existing tests must
pass unchanged against the new location.

`syncCardsForTask` is new: given a task id, find every recorded card containing
it and redraw each. That is what a web mutation calls.

**A Slack failure must never lose a task change.** The task write commits first;
the redraw runs after and its errors are caught and logged. A Slack outage
degrades the card, not the data.

## 4. Authentication and authorization

Auth.js with the Slack provider, JWT sessions in an encrypted cookie — no
session table, nothing to migrate.

**Authorization keys on the Slack user id**, taken from the account's
`providerAccountId`, checked against `AUTHORIZED_SLACK_USER_IDS` — the same
allowlist `apps/slack` already enforces. One source of truth for who may act,
and every web change is attributed to a real Slack user in the audit log.

The workspace id is checked **only if present** in the profile, because Auth.js
does not document the Slack profile's shape and designing around an
undocumented field is how things break silently later.

**This fails closed in two ways:**

1. An empty `AUTHORIZED_SLACK_USER_IDS` denies everyone rather than admitting
   everyone. The Slack app can fall back to a workspace check; the web app
   cannot, so it must not try.
2. Every page and every server action re-checks the session. There is no
   "authorized by virtue of having a URL".

### The development bypass

Because Slack demands https, local sign-in is impossible without a tunnel. So a
bypass exists, and it is deliberately hard to leave on:

```
WEB_DEV_USER=U01ABCDEF   # only honoured when NODE_ENV !== 'production'
```

Both conditions are required. A test asserts the bypass is inert with
`NODE_ENV=production` even when the variable is set. This is recorded as the one
place the app trusts an environment variable over a real identity.

## 5. Pages

| Route | Purpose |
|---|---|
| `/` | My Tasks — open tasks across all Spaces, filtered |
| `/spaces` | Every Space with open / waiting / completed counts, plus task creation |
| `/spaces/[slug]` | One Space |
| `/waiting` | Every waiting task, cross-Space, with `waiting_on` and age |
| `/history` | Completed tasks, filtered by date range, Space, assignee, text |
| `/settings` | Channel→Space mappings, default Space, authorized users, import batches |

Filters live in the URL as query parameters, so a filtered view is linkable and
the back button behaves. Filtering happens in SQL through `listTasks`, not in the
browser over a full dump.

Actions available on a task row: complete, reopen, move Space, change status,
reassign, set or clear due date, edit `waiting_on`, and edit the title.

**Title editing is an explicit action only.** A dedicated edit form, submitted
deliberately. No inline-on-blur, no autosave, nothing that could rewrite a title
as a side effect of clicking near it. It calls `editTask`, the same single write
path the Slack modal uses.

## 6. Settings exposes no secrets

Settings shows channel mappings, the default Space, the authorized user list, and
import history. It never reads a token, key, or connection string into a page.

A test scans rendered output for anything shaped like a credential — values
beginning `xox`, `sk-`, `xapp-`, or containing `postgres://` — and fails if one
appears.

## 7. Responsive

One column on a phone, denser on a desktop. Task rows are readable at 375px
without horizontal scrolling. Server-rendered, so first paint needs no
JavaScript; interactions use Server Actions with progressive enhancement.

No client-side state library, no data-fetching library. The server renders the
list; actions revalidate it.

## 8. Deployment

Vercel, against Supabase.

Consequences that shape the code:

- **Postgres, not PGlite.** `DATABASE_URL` points at Supabase. The existing
  `pg` driver path already covers this.
- **Supabase's transaction-mode pooler (port 6543) is the right URL.** It pools
  per transaction, so `db.transaction()` works, and `pg`'s default unnamed
  prepared statements are compatible. Named prepared statements are not, and the
  code uses none.
- **Serverless means many short-lived pools.** The pool is configured small and
  reused across invocations via a module-level singleton.

Local development runs `pnpm web` against either PGlite or Supabase, with the
development bypass for sign-in.

## 9. Testing

Vitest against real PGlite, at the server-action and data-function layer — the
same layer everything else in this repo is tested at. The brief's tests 1-7:

1. the same task state appears through the API and through the web data layer
2. completing from the web writes through to the database
3. reopening from the web writes through
4. an exact title is unchanged unless explicitly edited
5. filters return the correct rows
6. the waiting view shows only waiting tasks
7. completed history is accurate

Plus: the authorization guard denies an empty allowlist, the development bypass
is inert in production, a Slack redraw failure does not roll back the task
change, and no credential-shaped value reaches a rendered page.

**No browser rendering tests.** That needs a DOM environment and a second
testing stack, and it would assert my markup rather than your data. Click-through
verification belongs to `/qa` with a real browser, later.

## 10. Deferred

The Slack import wizard, next. Gantt, time tracking, dependency graphs, billing,
chat, comments, attachments, CRM, complex roles, AI task rewriting, autonomous
bulk cleanup — none of these, per the brief.
