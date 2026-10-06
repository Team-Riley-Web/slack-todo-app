# Scheduled Slack posts

Once a week the Tasks app posts **task briefings**: one per channel, each
carrying only the tasks that belong in that channel, each rendered from the
task database at the moment the job runs. Nothing else is scheduled here.

Nothing here reasons about your tasks. No Hermes, no MCP, no model. The
briefings keep working if every AI surface is switched off.

## Who owns which schedule

| Owner | Schedules |
|---|---|
| **Tasks app (Vercel Cron)** | The weekly task briefings. Mondays, once. |
| **Hermes** | Daily Anchors, EOS reminders (Level 10, Same-Page, Quarterly), EOS intelligence, finance reports, weekly/monthly analysis, integration health checks, client intelligence, follow-up and commitment intelligence, and every other recurring operating workflow. |

History: until 2026-09-11 this app ran an hourly dispatcher for the EOS
reminders; until 2026-10-06 it posted two daily lists ("Agency Tasks — Today",
"Personal Tasks — Today"). Both are gone. `tests/determinism.test.ts` asserts
that neither came back, and that the scheduler names no Hermes or MCP surface.

## When

```json
{ "path": "/api/cron/scheduled", "schedule": "0 13 * * 1" }
```

**Mondays at 13:00 UTC, once a week** — the same hour the daily post used to
fire, so the local time is unchanged:

| Season | Chicago offset | Local delivery |
|---|---|---|
| Mid-March → early November (CDT) | UTC−5 | **Monday 08:00** |
| Early November → mid-March (CST) | UTC−6 | **Monday 07:00** |

**The 08:00 target is not guaranteed year-round, deliberately.** Vercel Cron
expressions are UTC only, so one fixed entry cannot follow a zone that changes
its offset. Hitting 08:00 in both seasons would need two entries (one disabled
by hand half the year) or a poll that checks the local clock — the hourly loop
this app removed. CDT covers about eight months, so 13:00 UTC is on target for
most of the year and an hour early for the rest. A briefing that needs exact
local timing belongs to Hermes.

On the Hobby plan Vercel also treats the time as approximate: the run can
land anywhere in the 13:00 UTC hour (up to 08:59 CDT / 07:59 CST). It is
Monday morning in Chicago throughout that window, so the week key never slips.

Hobby allows a cron entry to run **at most once per day**; this one runs once
a week. That limit is on invocations, not posts — one invocation sends every
channel's briefing. `packages/scheduler/src/cron.test.ts` holds the line:
exactly one entry, fixed minute and hour, day-of-week `1` and nothing else.

## Where each Space goes

Every Space goes to **at most one** channel, decided in one place
(`packages/scheduler/src/routing.ts`):

| Briefing | Channel | Spaces |
|---|---|---|
| **Agency Tasks** | `SCHEDULED_AGENCY_CHANNEL_ID` (#agency-ops) | Inbox, Agency / Internal, Marketing, Sales |
| **Personal Tasks** | `SCHEDULED_PERSONAL_CHANNEL_ID` (#personal-ops) | Personal, Music, Spiritual — minus the Daily Anchors |
| **One per client** | the channel mapped to that client's Space; **#agency-ops** if it has none | that client only (a section of the Agency post if unmapped) |
| **Finances** | the channel mapped to the Finances Space | Finances only |
| **Any other Space** | the channel mapped to it | that Space only |

### Client and Finance channels come from the app's own mapping

The client and Finance briefings read `channel_space_map` — the same table
`/space` and `/map` write when you set a channel up, and the same one that
files a task captured in that channel. So:

- Map a channel (`/space` or `/map` in it, or Settings in the web app) and it
  gets a briefing next Monday. Nothing to configure here.
- A channel maps to exactly one Space, so a client channel can never carry a
  second client's tasks.
- Routing itself never looks at a channel's **name**; it reads the table.
  New channels get a row from the automatic mapping below, which is the only
  place a name is used.

### New channels map themselves

Before each weekly run (and on `pnpm scheduled sync-channels [--dry-run]`) the
app lists the bot's channels and maps any **unmapped** channel whose name is
exactly a Space's slug (`#yoga-farm`) or `client-` + slug
(`#client-yoga-farm`). It writes the same `channel_space_map` row `/map` does.

- It only fills gaps: a channel that already has a mapping is never changed,
  and a Space that already has a channel never gets a second.
- Inbox, the Agency and Personal Spaces, #agency-ops and #personal-ops are
  skipped. Substrings, suffixes and other near-misses are not guessed.
- Needs the `channels:read` and `groups:read` bot scopes (a reinstall, see
  SLACK_SETUP.md). Without them it is skipped with a log line and the
  briefings still post.
- A Space with no matching channel falls back to #agency-ops, below.

A Space with **no channel mapped**, or mapped to #agency-ops itself, is briefed
in the Agency post (#agency-ops) so its tasks are never dropped. Mapping a
channel later moves it to its own briefing.

A Space is **reported, not posted**, when its channel cannot be chosen safely.
`pnpm scheduled status` lists these under "not briefed", and the cron response
and logs carry each one as `unrouted` when it has open tasks:

- **More than one channel mapped.** Posting to both would put each task in two
  briefings, and picking one would be a guess. Unmap the extra.
- **Mapped to #personal-ops.** That would put client or finance work into
  exactly the briefing it must stay out of. Map it elsewhere.

A capture mapping on an Agency or Personal Space does not move it: Marketing
mapped to #marketing for capture still briefs in #agency-ops.

### "Spiritual"

The app has no spiritual category inside Personal; spiritual work lives in the
Personal Space. So the Personal briefing is Personal + Music, plus a
**Spiritual** Space automatically if you create one. To narrow #personal-ops to
strictly spiritual and music once that Space exists, set
`SCHEDULED_PERSONAL_SPACES=music,spiritual` — Personal then needs a channel of
its own, or it is reported as not briefed.

### The Daily Anchors stay out

These five are excluded from the Personal briefing, because Hermes posts and
tracks them on its own schedule:

```text
Meditate · Exercise · Journal · Cold Exposure · Vocal Warm-Ups
```

Matched on the **whole** title, case-insensitively and trimmed — never as a
substring. "Meditate" is excluded; *"Meditate with Rachael before the Level
10"* is a real task and still appears. This is a **delivery** rule: `/tasks
personal`, the web UI, the REST API and MCP still show all five.

## What a briefing looks like

```
Agency Tasks — Week of Oct 5
MARKETING
 [ ] [P0] Launch fall campaign
 [ ] [P1] Brief the designer
 …up to 10…
SALES
 [ ] Call Neil back
+4 more in Marketing (`/tasks marketing`)
```

- **Top 10 per Space**, highest priority first (`SCHEDULED_TOP_PER_SPACE`).
  The rest are a count with the command that shows them, not a dump.
- Order is the shared query's: `P0 → P1 → P2 → P3 → unprioritized`, then due
  date, then creation. Nothing in the scheduler ranks.
- Open tasks only. Waiting and completed are excluded, as in `/tasks all`.
- **Native checkboxes.** Each message is saved as a card, so ticking a box
  completes that task and redraws the message exactly as a `/tasks` card does.
- #agency-ops and #personal-ops post "Nothing open." on an empty week, so
  silence there means a failure. A client or Finance channel with nothing open
  gets no post.
- No task or Space ids, ledger keys or job names appear in Slack.

## Read-only on tasks

The run reads tasks and writes nothing to them: no create, complete, edit,
reassign or reschedule. The only rows it writes are its own ledger rows and the
`slack_cards` that keep the checkboxes live. A test snapshots every task
before and after a run and asserts they are identical.

## How it reuses `tasks all`

```
packages/task-core/src/grouping.ts
  listOpenTasksBySpace()      <- listTasks({ actionableOnly: true }) + group by Space
        |                        ordered by TASK_ORDER_BY: priority, then due, then created
        +-- apps/slack/.../tasks-command.ts      `/tasks all`
        +-- apps/web, apps/api, packages/mcp
        +-- packages/scheduler
              getOpenTasks()        -> ONE read per run
              planBriefings()       -> Space -> briefing, from channel_space_map
              tasksForBriefing()    -> each briefing's slice of that one read
```

The open tasks are read once per run and split by briefing. Since each Space
is in at most one briefing, no task can appear in two channels. A test posts
every briefing and checks no task id is on two cards.

## Not posting twice

`scheduled_runs` (migration `010`) holds one row per `(briefing, week)`. The
week is the **Monday of the Chicago ISO week**, so a Vercel retry, a manual
`dispatch`, or any second invocation later that week finds the briefing
claimed and posts nothing. The claim is `INSERT ... ON CONFLICT DO NOTHING`,
a lock in the database rather than in a serverless instance.

Ledger keys are `weekly:agency`, `weekly:personal`, and `weekly:space:<id>`
for mapped Spaces — the id rather than the slug, so renaming a client
mid-week does not re-deliver its briefing. Old `agency-daily` /
`personal-daily` rows are history and are never read.

## Failure behaviour

Briefings are **isolated**: each claims its own ledger row and is wrapped
separately, and they run one after another. A failed post (say
`not_in_channel` in a client channel) is logged with a sanitized error,
releases only its own claim, and does not stop the next channel. Re-running
`dispatch` later that week retries only what failed. There is no retry loop.

Errors are sanitized before they reach a log: anything matching a Slack token
or a bearer header is masked, and the message is truncated.

### Failure alerts come to you in Slack

You do not have to go looking. When a weekly run has a problem, the bot posts
a plain-language warning in **#agency-ops**: which briefing, which channel,
what went wrong and the fix. It alerts on a failed post, on open tasks in a
Space that cannot be routed (two channels, or mapped to #personal-ops), and on
a whole-run crash (database down, bad config) where nothing posted at all.
Quiet client channels and clean runs send nothing.

If #agency-ops is itself the problem (archived, bot removed), or the post to
it fails, the bot **DMs you** instead. The DM goes to `SCHEDULED_ALERT_USER_ID`,
else `DEFAULT_ASSIGNEE_SLACK_ID`, else the first `AUTHORIZED_SLACK_USER_IDS`,
so it works with no new setting. A rehearsal (`--dry-run`) never alerts. If
even the DM fails (Slack fully down) the alert goes to the Vercel log.

### When Slack fails: what the error means

Find them in Vercel -> Logs for `/api/cron/scheduled`, in the cron response
(`status: "failed"`, with a `reason`), or in `pnpm scheduled status`.
Re-run `pnpm scheduled dispatch` after fixing; only the failed ones retry.

| Error | Meaning | Fix |
|---|---|---|
| `not_in_channel` | Private channel the bot is not in (public ones are covered by `chat:write.public`). | `/invite @Tasks` in that channel. |
| `channel_not_found` | The channel was deleted or archived, or the id is wrong (a Space mapped to a dead channel, or a bad `SCHEDULED_*_CHANNEL_ID`). | Remap with `/map`, or fix the env var. |
| `is_archived` | The mapped channel was archived. | Unarchive it or `/map` the Space to a live channel. |
| `missing_scope` | The bot token lacks a scope. | Add it under OAuth & Permissions and **reinstall**. In `channel sync skipped: missing_scope` (a log line, not a failure) it is only the automatic mapping that is off; briefings still post. |
| `invalid_auth` / `token_revoked` / `account_inactive` | `SLACK_BOT_TOKEN` is wrong, or was replaced by a reinstall or rotation. | Copy the current Bot User OAuth Token (Install App) into Vercel, redeploy. |
| `ratelimited` | Too many posts at once. | Re-run `dispatch` a minute later. |
| `msg_too_long` / `invalid_blocks` | A briefing outgrew a message. | The planner chunks by design; this is a bug, so capture the `reason` and the Space. |

A briefing that did not appear at all is usually **not an error**: a client or
Finance Space with nothing open posts nothing, by design. Check `pnpm scheduled
status`: "recent runs" shows `posted`, `skipped` or `failed` per briefing.
Open work in a Space no briefing can carry shows as `unrouted`.

If Slack is down, Vercel Cron does not retry. Run `pnpm scheduled dispatch`
once it is back; the ledger makes it safe and it never double-posts.

## Configuration

| Variable | Meaning |
|---|---|
| `SCHEDULED_AGENCY_CHANNEL_ID` | #agency-ops |
| `SCHEDULED_PERSONAL_CHANNEL_ID` | #personal-ops |
| `SCHEDULED_AGENCY_SPACES` | Agency briefing Spaces, slug or name. Default `agency-internal,marketing,sales`. Inbox is always in. |
| `SCHEDULED_PERSONAL_SPACES` | Personal briefing Spaces. Default `personal,music,spiritual`. |
| `SCHEDULED_TOP_PER_SPACE` | Tasks shown per Space. Default `10`. |
| `SCHEDULED_ALERT_USER_ID` | Optional. Who gets the failure DM. Defaults to the default assignee. |
| `CRON_SECRET` | Bearer token on the cron route. `openssl rand -hex 32` |

Client and Finance channels need no variable — map them, or name the channel
after the Space and it maps itself. With `chat:write.public` the bot can post
to any **public** channel unprompted; for a **private** channel (#personal-ops,
a private client channel) invite it, or that one briefing fails with
`not_in_channel`.

## Testing without waiting for the cron

```sh
pnpm scheduled status                    # routing table, "not briefed", recent runs
pnpm scheduled preview agency            # render to the terminal, post nothing
pnpm scheduled preview joy-within-birth  # any mapped Space, by slug
pnpm scheduled run finances --dry-run    # the production path, printed
pnpm scheduled run finances              # post that one briefing to Slack now
pnpm scheduled dispatch --dry-run        # the WHOLE weekly dispatch, printed
pnpm scheduled dispatch                  # the whole dispatch, for real
```

`run` and `dispatch` both call the production handler — there is no separate
test-only path. `run` bypasses the ledger, so a test post does not consume
this week's delivery. `dispatch` honours it; `--dry-run` prints instead of
posting **and** leaves the ledger untouched.

Against the deployed app, with `CRON_SECRET`:

```sh
# Exactly what Vercel Cron does. Idempotent for the week.
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://<domain>/api/cron/scheduled

# One briefing, immediately, bypassing the ledger.
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://<domain>/api/cron/scheduled?job=agency"
```

`job` is `agency`, `personal`, or a mapped Space's slug. Anything else is a
400 listing the valid names — the retired `agency-daily`, `personal-daily` and
`eos-*` jobs included.

## Deploying

1. No migration: `scheduled_runs` is unchanged.
2. In the Vercel project, check `SCHEDULED_PERSONAL_SPACES`. The previous
   example set it to `personal`, which would leave Music out of #personal-ops.
   Delete it to take the default, or set `personal,music,spiritual`.
3. Make sure the Finances Space and each client Space are mapped to their
   channel, and the bot is in each private one. `pnpm scheduled status` against
   production shows the routing table and anything not briefed. It needs the
   real `DATABASE_URL` in your shell: `vercel env pull` blanks secrets to
   `[SENSITIVE]`, which silently points the script at an empty local database.
4. Deploy. This repo is private on Vercel Hobby, so pushes do not deploy:
   run `vercel --prod` from the repo root, and make sure the tip commit's
   author is on the Vercel team. Confirm **one** entry, `0 13 * * 1`, under **Project → Settings →
   Cron Jobs**.

## The EOS wording Hermes is taking over

Kept here only so the handover does not lose the exact text the Tasks app used
to send. Nothing in this repo renders it any more.

```text
Team Riley Level 10          (Fridays, 11:00 America/Chicago)
Weekly Level 10 Meeting
Joshua + Rachael
60–90 minutes

Team Riley Level 10 + Same-Page   (first Friday of the month, combined)
…the above, plus:
Monthly Same-Page Meeting
Joshua + Rachael
60–90 minutes

Team Riley Quarterly         (Monday 08:00 of the first full week of Jan/Apr/Jul/Oct)
Quarterly EOS planning is scheduled for this week.

Duration: Half day
Joshua + Rachael
```

## Known limits

- A run reads at most 500 open tasks (`listTasks` caps there). Past that it
  logs a warning and records `truncated: true` rather than under-posting
  silently.
- A run stuck on `outcome = 'claimed'` means an invocation died mid-post. It is
  left visible rather than retried automatically, because a retry could
  double-post. `pnpm scheduled status` shows it.
- Ticking a checkbox redraws that message from its tasks, as every card does;
  the briefing's title and "+N more" line are not part of the redraw.
