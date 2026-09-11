# Daily-only scheduling — spec as given, 2026-09-11

Captured verbatim so the `TASKS.md` entry stays one line. Nothing inferred.

## Goal

Remove the hourly dispatcher. The Tasks app uses Vercel Cron only for
deterministic morning task delivery. All other scheduled intelligence and
reminders belong to Hermes.

## Ownership

**Tasks app / Vercel owns:** Agency Tasks morning post; Personal one-time Tasks
morning post.

**Hermes owns:** EOS reminders, EOS intelligence, finance reports,
monthly/weekly analysis, integration health checks, client intelligence,
follow-up/commitment intelligence, all other scheduled operating workflows.

Do not duplicate these responsibilities.

## Remove the hourly cron

Current scheduling uses `0 * * * *`. Remove it. Do not poll hourly. Do not keep
an hourly dispatcher whose only purpose is checking whether something should
post. The Tasks app does not need a scheduler loop.

## Daily dispatch

One daily cron-driven morning dispatch. The handler: query current
source-of-truth tasks at execution time, post Agency, post Personal one-time,
stop. No AI, no Hermes, no MCP, no cached snapshot.

## Agency morning delivery

Current open Agency/business tasks into Agency Ops, via the existing canonical
query/rendering path, per the app's current Agency scope. Preserve exact
titles, priority ordering, native Slack checkbox UI, current Space/list
metadata, no completed tasks. No AI summarising or prioritising.
Header: `Agency Tasks — Today`.

## Personal morning delivery

Current open one-time Personal tasks into the Personal Slack channel, via the
existing canonical path. **Do NOT include the five Hermes-managed Daily
Anchors:** Meditate, Exercise, Journal, Cold Exposure, Vocal Warm-Ups. Those
remain Hermes-owned. Preserve exact titles, priority ordering, native checkbox
UI, no completed tasks. Header: `Personal Tasks — Today`.

## Time / Vercel Hobby compatibility

- No cron entry may run more than once per day.
- No hourly/minutely scheduling, no keep-warm cron, no polling loop.
- Use the simplest valid once-per-day Vercel cron schedule.

Vercel cron uses UTC and Hobby delivery timing may have coarse precision. Do
not introduce complex DST workarounds unless already supported cleanly.
Document the exact UTC schedule chosen and the local America/Chicago window it
produces under CST and CDT. **If exact 8:00 AM America/Chicago cannot be
guaranteed cleanly on Hobby, state that clearly in documentation rather than
adding extra polling.** Hermes will own schedules needing exact local timing.

## Remove EOS scheduling from the Tasks app

Retire Tasks-app scheduled delivery for Friday Level 10, Monthly Same-Page and
Quarterly EOS reminders. Hermes now owns those. Do not remove EOS-related data
structures if they are used elsewhere — only the scheduled delivery
responsibility.

## Shared query logic

Reuse the same shared functions already used by `tasks all`, Slack views, the
web UI and the API/MCP. Do not create separate cron-only retrieval logic.
Priority ordering must come from the shared task query/domain layer.

## Failure behaviour

Agency and Personal posts are isolated. Agency failure: log a sanitized error,
still attempt Personal. Personal failure: log a sanitized error, do not retry
in a tight loop. Never expose credentials.

## Manual testing

A safe manual invocation of the daily dispatcher, using the exact same
production handler. No separate fake scheduling logic.

## Tests required

1. no hourly cron remains
2. every Vercel cron entry runs at most once per day
3. daily dispatcher queries fresh data
4. Agency post uses current open Agency tasks
5. Personal post uses current open Personal tasks
6. completed tasks excluded
7. priority ordering preserved
8. Daily Anchors excluded
9. Agency failure does not block Personal attempt
10. Personal failure does not corrupt Agency post
11. no Hermes/MCP dependency exists in scheduler
12. EOS reminders no longer originate from Tasks app
13. manual invocation reuses production handler

## Documentation

Update `SCHEDULED.md` to state Tasks-app ownership (once-daily Agency, once-daily
Personal) and Hermes ownership (EOS, finance, intelligent reports, all other
recurring operations). Document the exact cron expression, UTC timing, expected
America/Chicago timing, the Hobby timing limitation, and the manual test
procedure.

## Report back with

1. files changed
2. old cron removed
3. new cron expression
4. expected CST/CDT local delivery time
5. Agency destination
6. Personal destination
7. EOS scheduling removed from Tasks app
8. shared query functions reused
9. manual test command/endpoint
10. tests/results
11. deployment/config changes required
12. blocker, if any
