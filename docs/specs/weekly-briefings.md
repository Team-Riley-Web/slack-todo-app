# Weekly channel-scoped briefings — spec as given, 2026-10-06

Supersedes [`daily-only-scheduling.md`](daily-only-scheduling.md). Captured so
the decisions behind `SCHEDULED.md` are not lost. Decisions made in
conversation are marked **Decided**.

## Goal

Replace the daily Agency-wide digest with a weekly, channel-scoped task
briefing system. Modify the existing Tasks app scheduler and routing — no
parallel scheduler, no Hermes cron.

## Routing

1. **#agency-ops** — only marketing, sales, agency operations, and open Inbox
   tasks. Exclude all client delivery work, finance, spiritual and music.
2. **Each client channel** — that client's tasks only, in its mapped client
   channel. Never mix clients. Use the app's authoritative client/channel
   mapping; never infer routing from a channel name.
   **Decided:** the mapping is `channel_space_map`, the table `/space` and
   `/map` already maintain when a channel is set up — the same one capture
   uses. A newly mapped channel gets its briefing with no config change.
3. **#personal-ops** — only personal spiritual and music tasks. Preserve
   unrelated Personal Daily Anchors behaviour.
   **Decided (by default, overridable):** the app has no "spiritual"
   category; spiritual work lives in the Personal Space. So the Personal
   briefing is Personal + Music + a Spiritual Space if one is created
   (`SCHEDULED_PERSONAL_SPACES`, default `personal,music,spiritual`). The five
   Hermes-owned Daily Anchors stay excluded.
4. **Finance** — finance tasks only in the designated Finance channel; never in
   #agency-ops or #personal-ops.
   **Decided:** "designated" means the channel mapped to the Finances Space,
   by the same mapping as the clients.

## Scheduling

- Daily → weekly. **Decided:** Monday.
- Preserve the existing local time as closely as possible; document the exact
  day/time and the Vercel timezone/DST limitation.
- Only one scheduled run produces each weekly briefing — no duplicate daily
  and weekly posts.

## Data and safety

- The Tasks app is the sole authority for task state.
- Read and render only: never create, complete, edit, reassign or reschedule
  a task as part of a briefing.
- Preserve priority ordering and native task-card checkbox behaviour.
- Concise and attention-focused, not a dump of every task.
- No internal IDs or implementation details in Slack messages.

## Acceptance criteria

- The daily Agency Tasks digest no longer posts daily.
- The weekly #agency-ops briefing contains only marketing, sales, agency and
  Inbox items.
- Client tasks post only in their correct mapped client channels.
- Spiritual and music tasks post only in #personal-ops.
- Finance tasks post only in the Finance channel.
- No task appears in more than one channel's weekly briefing.
- Daily Anchors and unrelated scheduled automations still work unchanged.
- Automated tests for scheduling, category filtering, channel routing,
  exclusion rules and duplicate prevention.
- Deploy to production; verify the deployed cron configuration and a safe
  end-to-end run.

## Constraint confirmed before implementation

Vercel Hobby limits how often a cron entry fires (at most once a day), not
how many messages one invocation sends. One weekly entry fanning out to every
channel is well within it.
