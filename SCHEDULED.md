# Scheduled Slack posts

The Tasks app delivers **two messages a day and nothing else**: the open Agency
list and the open Personal list, each into its own channel, each rendered from
the task database at the moment the job runs.

Nothing here reasons about your tasks. No Hermes, no MCP, no model — those can
consume the same functions for planning later; these two posts work on their
own and keep working if every AI surface is switched off.

## Who owns which schedule

| Owner | Schedules |
|---|---|
| **Tasks app (Vercel Cron)** | Agency task post, Personal task post. Once daily, each. |
| **Hermes** | EOS reminders (Level 10, Same-Page, Quarterly), EOS intelligence, finance reports, weekly/monthly analysis, integration health checks, client intelligence, follow-up and commitment intelligence, and every other recurring operating workflow. |

That split is the whole design. Before 2026-09-11 this app ran an **hourly**
dispatcher whose only job was to ask "is anything due?" — it existed because
the EOS reminders needed several different times of day. Hermes owns those now,
so the question disappeared and the loop went with it. There is no scheduler
loop here any more, no grace window, and no calendar arithmetic.

`tests/determinism.test.ts` asserts both halves: the scheduler package names
no Hermes or MCP surface in its code, and no EOS delivery was left behind.

## What goes out, and when

| Job | Channel | Message |
|---|---|---|
| `agency-daily` | `SCHEDULED_AGENCY_CHANNEL_ID` | **Agency Tasks — Today** |
| `personal-daily` | `SCHEDULED_PERSONAL_CHANNEL_ID` | **Personal Tasks — Today** |

### The cron entry

```json
{ "path": "/api/cron/scheduled", "schedule": "0 13 * * *" }
```

**13:00 UTC, once a day.** That is:

| Season | Chicago offset | Local delivery |
|---|---|---|
| Mid-March → early November (CDT) | UTC−5 | **08:00** |
| Early November → mid-March (CST) | UTC−6 | **07:00** |

**The 8:00 target is not guaranteed year-round, deliberately.** Vercel Cron
expressions are UTC only, so one fixed entry cannot track a zone that moves.
Hitting 08:00 in both seasons would need either two entries (one of which must
be disabled half the year, by hand) or an hourly poll that checks the local
clock — which is exactly what this refactor removed. CDT covers about eight
months of the year, so 13:00 UTC is on target for most of it and an hour early
for the rest.

Vercel also treats the scheduled time as approximate rather than exact, and on
Hobby a cron entry may run **at most once per day**. `packages/scheduler/src/cron.test.ts`
asserts that: exactly one entry, never `0 * * * *`, and neither the minute nor
the hour field may contain a wildcard, list, range or step.

If you want a guaranteed 08:00 local post, that belongs to Hermes, which owns
the schedules needing exact local timing.

## The Agency / Personal split

`Personal` is Personal. **Everything else is Agency** — Agency / Internal,
Marketing, Sales, Music, Inbox and every client Space. Defined as a complement
rather than two lists, so the two posts together cover every Space and a Space
created next month appears in the Agency post rather than in neither. Override
with `SCHEDULED_PERSONAL_SPACES`.

### Daily Anchors are excluded from the Personal post

These five stay out, because Hermes posts and tracks them on its own schedule:

```text
Meditate · Exercise · Journal · Cold Exposure · Vocal Warm-Ups
```

Matched on the **whole** title, case-insensitively and trimmed — never as a
substring. "Meditate" is excluded; *"Meditate with Rachael before the Level 10"*
is a real one-off task and still appears. A substring rule would silently
swallow it.

This is also what "one-time Personal tasks" means in practice: the app has no
notion of a recurring task, so excluding the five recurring ones **is** the
one-time filter.

The exclusion is a **delivery** rule, not a query change. `/tasks personal`,
the web UI, the REST API and MCP all still show all five.

## How it reuses `tasks all`

One query, one renderer, every surface:

```
packages/task-core/src/grouping.ts
  listOpenTasksBySpace()     <- listTasks({ actionableOnly: true }) + group by Space
        |                       ordered by TASK_ORDER_BY: priority, then due, then created
        |
        +-- apps/slack/.../tasks-command.ts      `/tasks all`
        +-- apps/web, apps/api, packages/mcp
        +-- packages/scheduler/src/jobs.ts
              getAllOpenAgencyTasks()    -> Agency space filter
              getAllOpenPersonalTasks()  -> Personal space filter, minus Daily Anchors
```

`actionableOnly` means `status = 'open'`: waiting and completed are both
excluded. Priority ordering comes from `TASK_ORDER_BY` in the query layer, not
from anything in the scheduler — `P0 → P1 → P2 → P3 → unprioritized`, then due
date, then creation.

Rendering is shared too: `taskListBlocks()` draws the native checkboxes and
`saveCard()` records each posted message, so ticking a box in tomorrow
morning's post completes the task and redraws that message exactly as a
`/tasks` card does. Titles are byte-exact.

One deliberate difference: `/tasks all` drops whole Spaces past Slack's 50-block
limit with a note. A digest cannot, so `planTaskMessages` splits across as many
messages as it takes, and a test asserts no task is ever dropped.

## Failure behaviour

The two posts are **isolated**. Each claims its own ledger row and each is
wrapped separately, so:

- Agency fails → sanitized error logged, **Personal is still attempted**.
- Personal fails → sanitized error logged, Agency's delivery is untouched and
  stays recorded as posted.

A failed job releases only its own claim, so the next day's run retries just
that one. There is no retry loop.

Errors are sanitized before they reach a log: anything matching a Slack token
or a bearer header is masked, and the message is truncated. A job whose channel
is unset is skipped and logged rather than throwing.

### Not posting twice

`scheduled_runs` (migration `010`) holds one row per `(job, local date)`. A run
claims its occurrence with `INSERT ... ON CONFLICT DO NOTHING`; whichever
invocation gets a row back does the work. The lock is in the database, not in a
warm serverless instance, because there is no such thing as one warm instance.

## Configuration

| Variable | Meaning |
|---|---|
| `SCHEDULED_AGENCY_CHANNEL_ID` | Agency post destination |
| `SCHEDULED_PERSONAL_CHANNEL_ID` | Personal post destination |
| `SCHEDULED_PERSONAL_SPACES` | Space slugs/names treated as Personal (default `personal`) |
| `CRON_SECRET` | Bearer token on the cron route. `openssl rand -hex 32` |

Invite the bot to both channels — `chat.postMessage` to a channel it has not
joined fails with `not_in_channel`.

## Testing without waiting for the cron

```sh
pnpm scheduled status                  # config, and recent runs
pnpm scheduled preview agency-daily    # render to the terminal, post nothing
pnpm scheduled preview personal-daily
pnpm scheduled run personal-daily      # post that one list to Slack now
pnpm scheduled dispatch --dry-run      # the WHOLE daily dispatch, printed
pnpm scheduled dispatch                # the whole dispatch, for real
```

`run` and `dispatch` both call the production handler — there is no separate
test-only scheduling path to drift. `run` bypasses the ledger, so testing at
2pm does not consume tomorrow morning's delivery. `dispatch` honours it;
`--dry-run` prints instead of posting **and** leaves the ledger untouched.

Against the deployed app, with `CRON_SECRET`:

```sh
# Exactly what Vercel Cron does: both posts, then stop.
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://<domain>/api/cron/scheduled

# One post, immediately, bypassing the ledger.
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://<domain>/api/cron/scheduled?job=agency-daily"
```

Jobs: `agency-daily`, `personal-daily`. Anything else is a 400 — the retired
`eos-*` jobs included.

## Deploying

1. `pnpm migrate` (already applied; `010_scheduled_runs.sql` is unchanged).
2. Set the four variables above in the Vercel project.
3. Invite the bot to both channels.
4. Deploy. Confirm **one** entry under **Project → Settings → Cron Jobs**.

Hobby is now sufficient: one entry, once a day.

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

- A digest asks for at most 500 open tasks (`listTasks` caps there). Past that
  the job logs a warning and records `truncated: true` rather than
  under-posting silently.
- A run stuck on `outcome = 'claimed'` means an invocation died mid-post. It is
  left visible rather than retried automatically, because a retry could
  double-post. `pnpm scheduled status` shows it.
