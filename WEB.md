# Web UI

Slack remains the primary task interface. This web app exists for the things a
chat window is bad at: scanning everything at once, filtering, reviewing
history, and editing the fields that do not fit on a card.

It is the same backend. Same database, same task IDs, same `task-core`
functions. There is no second copy of any rule.

## Views

| Route | What it is |
| --- | --- |
| `/` | My Tasks. Open and waiting tasks, filterable by status, assignee, due bucket, and title search. No Space chips — the rail is the Space filter. With no Space chosen (All spaces) it opens with an outlined **Today** card: everything overdue or due today from every Space, with a Space column and a one-click **Tomorrow** per row. |
| `/today` | Everything due today, across every Space. "Today" is the calendar day in `DEFAULT_TIMEZONE` (America/Chicago), overdue work included. |
| `/spaces` | Every Space with its open / waiting / completed counts. Empty Spaces are listed too, and an empty one can be deleted here. |
| `/spaces/<slug>` | One Space in three collapsible sections — Open, Waiting, Completed — plus the form for adding a task. The rows do not repeat the Space name the heading already carries. |
| `/waiting` | Waiting and blocked tasks, oldest first, with an age in days. |
| `/history` | Completed tasks, filterable by date range. |
| `/settings` | Channel → Space mappings, the authorized user list, the timezone, and import history. |
| `/tasks/<id>/edit` | The only place a title changes from the web. Renders as a pane over the list. Every field the Slack modal offers, prefilled, plus the task's event history. |

## The logo

`apps/web/public/tasks-logo.png` — 512×512 — serves three jobs: the browser
tab icon, the iOS home-screen icon, and the header mark beside "Team Riley".

Declared through `metadata.icons` in `app/layout.tsx` rather than the
`app/icon.png` file convention, because the convention wants its own copy of
the file and two copies of an image drift apart. One source, three uses.

It sits in the top bar rather than above the rail, where Workast puts it. The
rail is absent on Settings and behind the edit pane, and an identity that
disappears on some pages is worse than one that never moves.

Worth knowing: a 512px PNG is a heavy favicon (86 KB) and the browser scales
it down. Fine for an internal tool on a fast connection; if it ever matters,
generate a 32px and a 180px variant and list both in `icons`.

## Why there is no client JavaScript, and what that costs

Every interaction is a form posting a server action or a link. That is a
deliberate constraint, and it shapes three things:

- **Completing a task is a submit button**, drawn as a circle check. It was
  once a `readOnly` checkbox next to a hidden submit button, which could not
  be clicked at all — a checkbox does not submit a form, and there was no
  script to submit one for it.
- **Collapsible sections are `details`/`summary`**, with a CSS-only chevron.
- **The edit pane is a real route**, not a dialog. The backdrop is a link back
  to the list, so closing needs no script, the URL is linkable, and the back
  button behaves.

## Layout

The structure follows Workast, because that is the reference and the previous
version's problem was architectural rather than chromatic:

- **One dark rail carries all navigation.** Workspace identity, the
  cross-Space views, the Space list, and Settings. There is no top bar. The
  earlier version split them — a top bar for views, a light rail for Spaces —
  which is why it never read like the reference however the colours were
  tuned.
- **The main column is content only**: a page heading with a subtitle, a
  toolbar row, then cards.
- **Task lists are cards**, each with a collapse chevron, a count, a table
  header naming the columns, and a "+ Create new task" footer.
- **Rows are a grid**, not a flex line:
  `34px minmax(0,1fr) 128px 110px 92px 78px` — tick, title, Space, assignee,
  due, actions — shared by the header row and every task row, so the columns
  line up without a table element. A view filtered to one Space drops the
  Space track (`.row.nospace`), because naming it on every row of its own
  Space is not information. Below 860px the Space, assignee and due columns
  drop out and the Space returns to the title's sub-line, where it costs no
  width.

Colour and type now come from `docs/brand-spec.md`, whose tokens are declared
in `globals.css` twice each: a hex fallback, then the spec's own `oklch()`.
Five of its six values converted to exactly the hex already sampled from the
reference, so the spec documents this interface rather than redirecting it.

The one value it does change is the accent, which becomes the same cornflower
as the rail's selected row — one selection colour across both halves of the
app. White text on it measures 3.34:1, which clears the 3:1 bar for a UI
surface, border or focus ring but not the 4.5:1 one for text, so there is a
second token: `--accent-strong` at `oklch(0.57 0.1862 266.03)`, the lightest
point on the spec's own hue and chroma that passes AA in both directions
(4.63:1). The split is by surface, not by concept — the cornflower stays the
selection colour on the graphite rail, and anything on the near-white
workspace that puts white ON blue (the primary button, a selected chip) or
uses blue AS text (links) takes the darker step.

The rail keeps its own sampled greys (`#1e2432` and friends); the spec gives
no values for it. `#35ca8c` for the completed check and `#ea4954` for overdue
also stay: the spec reserves blue for selection and the primary action, which
says nothing about the status hues.

Type is two stacks: `--font-body` on everything, and `--font-mono` wherever a
literal is shown — a slash command, a slug, a channel id.

The spec's third stack, a display serif, is **deliberately not used**. It was
applied to the page heading, the pane heading and the team name in the rail,
and rejected on sight: "I don't like these serif fonts, just use the sans
serif font." The token is gone rather than left unused, so nothing reads it
back out of the spec by accident. This is the one place the implementation
overrides `docs/brand-spec.md` outright.

**This is a structural match, not a pixel-perfect one**, and it cannot be from
screenshots alone: font metrics, the exact spacing scale, and precise region
boundaries are not recoverable from a JPEG. Getting the rest would mean
reading computed styles off the live Workast app.

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
pnpm web                  # http://localhost:3040
```

`pnpm web` rather than `pnpm --filter @tr/web dev`: Next auto-loads only a
`.env` in its own directory, and this repo keeps one at the root, so the plain
command starts with no `DATABASE_URL` and no `WEB_DEV_USER` and redirects
every page to `/signin`.

Two dev-server traps, both of which look like application bugs:

- **A production build clobbers the dev server.** `next build` and `next dev`
  share `.next/`, so building while the dev server runs deletes the chunks it
  is serving. Pages still render and every stylesheet 404s — indistinguishable
  from broken CSS. Fix: stop the server, `rm -rf apps/web/.next`, start again.
  Use `pnpm web:build` and stop the dev server first.
- **Nothing pushes changes to an open page.** A task captured in Slack appears
  here on the next load, not live. Refresh.

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
`AUTH_SLACK_SECRET`, `AUTHORIZED_SLACK_USER_IDS`, `DEFAULT_TIMEZONE`,
`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, and `SLACK_TEAM_ID`. Add
`CRON_SECRET` for the scheduled posts (see `SCHEDULED.md`) and
`TASKS_MCP_TOKEN` for remote MCP (see `MCP_CONTRACT.md`). The Slack
values serve both card redraws and the production HTTP receiver. Do not set
`SLACK_APP_TOKEN`: it is only for local Socket Mode. Do not set `WEB_DEV_USER`;
it is inert in production anyway.

Run `pnpm migrate` against the database before the first deploy. Migrations
are deliberately **not** on the request path.

This app hosts three non-UI endpoints besides the pages: the Slack receiver at
`/api/slack/events`, the scheduled-post cron at `/api/cron/scheduled`, and
remote MCP for Hermes at `/mcp` (with `/mcp/health` for liveness). All three
are thin adapters — every credential and every piece of logic lives in a
package, which is what keeps `src/no-secrets.test.ts` passing.

`apps/web/vercel.json` enables Fluid compute. The Slack receiver is a Node
Route Handler at `/api/slack/events`; `GET` is its deployment health check and
`POST` accepts only requests carrying a current, valid Slack signature. Bolt
acknowledges before it touches Postgres, and Next's `after()` keeps the rest of
the listener alive after that response. The first completed listener in each
warm instance also runs the interaction-retention sweep that the local worker
runs on a timer. Do not add a keep-warm ping: the route is request-driven and
holds no socket.

After the first successful deploy, disable Socket Mode in the Slack app and
set every Slash Command plus Interactivity Request URL to:

```text
https://<production-domain>/api/slack/events
```

Keep the local `pnpm slack` process in Socket Mode until those URLs are saved,
so development and the production cutover never compete for deliveries.

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

## Siri quick capture

`POST /api/capture` lets an Apple Shortcut add a task, so "Hey Siri, add task"
works without opening anything. It has its own token, `CAPTURE_TOKEN` (set it
in Vercel; generate with `openssl rand -hex 32`). Unset, it refuses everything.

```text
POST https://<domain>/api/capture
Authorization: Bearer <CAPTURE_TOKEN>
{ "text": "P1 Call Neil about the renewal", "due": "today", "space": "Sales" }
```

- `text` is read like Slack `/task`: a leading P0-P3 is the priority. A spoken
  trailing "due today" / "due tomorrow" sets the date.
- `due` is optional: `today`, `tomorrow`, `none`, or `YYYY-MM-DD`.
- `space` is optional; without it the task goes to Inbox.
- The reply is one sentence for Siri to read back, e.g.
  "Added Call Neil about the renewal to Sales, due today."

Building the Shortcut on an iPhone:

1. Shortcuts → **+** → name it **Add Task** (that name is what you say to Siri).
2. Add **Dictate Text**.
3. Optional: add **Choose from Menu** with Today / Tomorrow / No date, and in
   each branch a **Text** action holding `today`, `tomorrow` or `none`.
4. Add **Get Contents of URL**: the URL above, Method **POST**, a header
   `Authorization` = `Bearer <token>`, Request Body **JSON** with
   `text` = *Dictated Text* (and `due` = the menu's Text, if you added step 3).
5. Add **Speak Text** with *Contents of URL*.

Then: "Hey Siri, Add Task" → say the task → it is filed and read back.
