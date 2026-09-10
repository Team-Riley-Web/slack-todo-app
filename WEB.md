# Web UI

Slack remains the primary task interface. This web app exists for the things a
chat window is bad at: scanning everything at once, filtering, reviewing
history, and editing the fields that do not fit on a card.

It is the same backend. Same database, same task IDs, same `task-core`
functions. There is no second copy of any rule.

## Views

| Route | What it is |
| --- | --- |
| `/` | My Tasks. Open and waiting tasks, filterable by space, status, assignee, due bucket, and title search. |
| `/spaces` | Every Space with its open / waiting / completed counts. Empty Spaces are listed too, and an empty one can be deleted here. |
| `/spaces/<slug>` | One Space, plus the form for adding a task to it. |
| `/waiting` | Waiting and blocked tasks, oldest first, with an age in days. |
| `/history` | Completed tasks, filterable by date range. |
| `/settings` | Channel → Space mappings, the authorized user list, the timezone, and import history. |
| `/tasks/<id>/edit` | The only place a title changes from the web. Every field the Slack modal offers, prefilled, plus the task's event history. |

## The Spaces rail

Every Space sits in a rail beside the content, so switching Space is one click
rather than re-reading a row of filter chips. It stacks above the content below
820px. Counts show only where there is something to count.

Order is Inbox first, then alphabetical **by the name as displayed**. Sorting by
the stored name looked broken: every client Space is stored as
`Client - Yoga Farm` and shown as `Yoga Farm`, so the whole client block sorted
under C and landed between `Agency / Internal` and `Marketing`. The sort key has
to match the text on screen.

## Creating a Space

On `/spaces`, or in Slack from the bare `/task` modal's "…or a new Space"
field. Both call `createSpace` in `task-core`.

The name is stored as typed apart from an outer trim, and `Client - ` is not
added for you — whether a Space is a client is your call, not a naming rule
the code invents. Creation is idempotent on the name: asking for a Space that
already exists returns it rather than failing, because a client arriving twice
is not worth blocking on. The slug is derived (`Client - Rosario Landscaping`
becomes `rosario-landscaping`) and made unique if it would collide. A new Space
gets the same two lists every seeded Space has.

## Deleting a Space

On `/spaces`, an empty Space has a Delete disclosure — two deliberate clicks,
no client JavaScript. `deleteSpace` in `task-core` owns the rules, so the same
answers apply wherever it is called from:

- **Inbox is refused.** Every unmapped capture falls back to it.
- **A Space holding tasks is refused**, completed ones included. Those are
  history; move them first. The page does not even offer the button, but the
  refusal is in the engine, not the UI.
- **Lists, channel mappings and aliases pointing at it are removed.** A channel
  mapped to a Space that no longer exists would be worse than an unmapped
  channel: captures would fail instead of falling back to Inbox.
- **Import staging pointers are cleared, not deleted.** `resolved_space_id` is
  derived; the source `space` text stays, so the record of what was submitted
  survives.

All of it in one transaction, so a refusal partway leaves nothing
half-deleted.

## Running it locally

```bash
pnpm install
cp .env.example .env      # then fill in DATABASE_URL, see below
pnpm migrate
pnpm --filter @tr/web dev # http://localhost:3040
```

### DATABASE_URL is required, and must be Postgres

The Slack app, the REST API and the MCP server all accept an empty
`DATABASE_URL` and fall back to in-memory PGlite. **The web app cannot.**

PGlite loads its Postgres build as a WASM file at runtime. Next bundles the
server code, the bundled module then reads that file with a `URL` where
Node's `fs.readFile` wants a path, and every route returns a 500 with
`ERR_INVALID_ARG_TYPE`. `serverExternalPackages` does not prevent it.

So `apps/web/src/db.ts` checks the URL up front and throws a readable error
rather than letting a request fail deep inside a bundled dependency.

Use the Supabase **transaction-mode pooler** (port 6543), not the direct
connection. Two independent reasons:

- Prepared statements are disabled automatically on that port, which is what
  transaction pooling requires.
- The direct host (`db.<ref>.supabase.co`) resolves to IPv6 only. From an
  IPv4-only network that fails as `ENETUNREACH`, which reads like the database
  being down rather than a routing problem. Checked 2026-09-10: that host has
  no A record at all, only AAAA.

The dashboard shows a notice on the Transaction pooler saying it "uses IPv6 by
default" and offering a dedicated IPv4 add-on. That notice did not match DNS
for this project on 2026-09-10: `aws-0-us-east-1.pooler.supabase.com` returned
three A records and no AAAA, and port 6543 accepted a connection over IPv4. So
the pooler is the IPv4 path today and the add-on is not needed. Re-check with
`dig +short A <pooler host>` before believing either source.

Get the exact string from the dashboard's **Connect** button, "Transaction
pooler". Do not hand-assemble it — the pooler hostname's region prefix is not
guessable from the project's region.

## The database, as it stands

Project **Team Riley Tasks**, ref `albtfpjmxpksydbnmzay`, us-east-1,
Postgres 17. Deliberately a **separate project** from Team Riley gBrain
(`marxnnnbojsaeetxyrwn`): gBrain is the system of record for 16,149 pages and
the PGLite backups are gone, so a bad migration or an import rollback here
must have no way to reach it.

All nine migrations are applied — 12 tables, 12 Spaces, 24 lists, one Space
alias. The runner tracks applied files in `public.schema_migrations`, and those
rows were written as part of the same transaction, so `pnpm migrate` against
this database is a no-op rather than an attempt to re-apply.

Supabase's security advisors report one INFO-level lint, "RLS enabled, no
policy", on all 12 tables. That is the intended posture, not a finding to fix
— see the API-surface section in ARCHITECTURE.md.

### Signing in

Sign-in is Slack OAuth through Auth.js. Slack requires the OAuth redirect to
use `https`, even on localhost, so plain local sign-in is impossible without a
tunnel. For development, set `WEB_DEV_USER` to your Slack user ID instead.

That bypass needs **both** a non-production `NODE_ENV` **and** the variable.
It returns nothing under `NODE_ENV=production`, so it cannot survive a
deploy — which means `next start` will correctly refuse it. Use `next dev`.

It supplies an identity, not authority. The result still goes through
`authorizeSlackUser`, which reads `AUTHORIZED_SLACK_USER_IDS` and **denies
everyone when that list is empty**. An unconfigured allowlist is a closed
door, not an open one.

For real OAuth:

- `AUTH_SLACK_ID` / `AUTH_SLACK_SECRET` — from the Slack app's OAuth settings
- `AUTH_SECRET` — `openssl rand -base64 32`
- Redirect URL to register with Slack: `https://<host>/api/auth/callback/slack`

## Changes here redraw the Slack card

Completing, reopening, moving or editing a task from the web calls
`syncCardsForTask`, which finds every Slack card showing that task and
redraws it in place. So a checkbox ticked in the browser appears ticked in
Slack.

That redraw needs `SLACK_BOT_TOKEN`. Without it the task still changes and
only the redraw is skipped, which is the right behaviour for a deployment
that was never given Slack credentials. A Slack API failure is swallowed for
the same reason: it must not fail the write that already succeeded.

## No credential reaches a page

`/settings` shows configuration, and configuration is where secrets leak. The
readable values are a narrow allowlist in `src/lib/env.ts`. Three files read a
credential at all, each for a stated reason:

- `actions/tasks.ts` — the bot token, to redraw a Slack card
- `session.ts` — `WEB_DEV_USER`, for the local bypass
- `db.ts` — `DATABASE_URL`, to check it is Postgres before connecting

`src/no-secrets.test.ts` enforces that: it puts real-shaped tokens in the
environment, renders the settings view, and asserts nothing token-shaped comes
out; then greps `src/app` and `src/components` for the forbidden names; then
asserts the reader list is exactly those three files. Add a fourth and the
test fails.

## Deploying to Vercel

Root directory `apps/web`. Build command `pnpm --filter @tr/web build`.

Environment variables: `DATABASE_URL`, `AUTH_SECRET`, `AUTH_SLACK_ID`,
`AUTH_SLACK_SECRET`, `AUTHORIZED_SLACK_USER_IDS`, `DEFAULT_TIMEZONE`, and
`SLACK_BOT_TOKEN` if you want the Slack redraw. Do not set `WEB_DEV_USER`;
it is inert in production anyway.

Run `pnpm migrate` against the database before the first deploy. Migrations
are deliberately **not** on the request path.

## Notes on the shape of it

Server-rendered, no client JavaScript. Filters are links carrying query
parameters, so every filtered view has its own URL that is shareable and
bookmarkable, and the back button behaves. The narrowing happens in SQL, not
by hiding rows already sent to the browser.

Titles are editable here, on a page of their own, reached deliberately. That
is the point: `editTask` in `task-core` is the single write path to
`tasks.title`, and it is reachable from exactly two human surfaces — the Slack
modal and this edit page. No MCP tool and no REST route can reach it, and
three tests in `tests/determinism.test.ts` assert that. AI can read tasks; it
cannot rewrite what you wrote.

## Verified against Supabase, 2026-09-10

The first time these pages rendered against real Postgres, this is what was
checked — recorded because "it builds" and "it works" are different claims:

- All five routes return 200 and render live data: 12 Spaces, correct empty
  states, no credential anywhere in the HTML.
- A task created through `task-core` reads back byte-exact, appears on `/`,
  `/spaces/marketing`, and its edit page, and is matched by `?q=neil` and
  `?due=none`.
- The same task is **absent** from `?space=sales`, `?q=zzzznomatch`,
  `/waiting`, and `/history` — filters exclude as well as include.
- Completing it moves it off `/` and onto `/history`, and the Spaces counts go
  from "1 open" to "1 done".
- A second `completeTask` leaves `completed_at` unchanged, so the idempotency
  that PGlite tests assert also holds on the pooler.

Test data was deleted afterwards; the database is back to 0 tasks and 12
Spaces.
