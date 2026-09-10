# Tasks

Queue of work for Claude. Add new tasks to the bottom. Do not remove or edit an
unchecked task unless you are starting it.

## Rules
- Work on only one task at a time.
- New tasks go at the bottom of the list.
- Do not abandon or interrupt the current task unless the user explicitly says "interrupt".
- Finish, test, and verify the current task before starting the next.
- Before starting another task, re-read this file and select the oldest pending (unchecked) task.
- After completing a task, check it off, briefly tell the user it's done, and state which task is starting next.
- Do not combine unrelated tasks into one implementation.
- When you check a task off, indent a short `Done YYYY-MM-DD:` note under it saying what
  actually changed. If the task cannot be finished, leave it unchecked and add a
  `Blocked YYYY-MM-DD:` note explaining what is needed to unblock it.

## Queue
- [x] Set up everything in Supabase via MCP — org https://supabase.com/dashboard/org/erzjknefhtmrscfudncn: new project for the task app, apply all 8 migrations, then verify the web UI renders
  - Done 2026-09-10: project Team Riley Tasks (ref albtfpjmxpksydbnmzay, us-east-1, PG 17), all 9 migrations applied, `pnpm migrate` confirmed a no-op. All 5 web routes render 200 against Supabase for the first time; create/complete verified end-to-end through task-core, title byte-exact, completion idempotent, filters include and exclude correctly. Test data removed; database back to 0 tasks, 12 Spaces.
- [x] Connect this repo to the private GitHub remote: git remote add origin https://github.com/TheRileyBird/slack-todo-app.git
  - Done 2026-09-10: origin added, master pushed first so it is the default branch, phase2b-web-ui pushed too. All 44 commits re-authored from joshua.riley@ziffmedia.com to 38710705+TheRileyBird@users.noreply.github.com before the first push (approved); tree hashes verified identical, so only authorship changed. Identity set repo-local only, global left alone. Pre-rewrite backup bundle in the session scratchpad; originals still in refs/original/*.
- [x] Set up a personal SSH key so this repo pushes without depending on the active gh account
  - Done 2026-09-10: no key needed. ~/.ssh/id_ed25519_rileybird and the `github-riley` host alias
    already existed and authenticate as TheRileyBird. Switched origin to
    git@github-riley:TheRileyBird/slack-todo-app.git and dropped the repo-local https helper.
    Verified a write-auth dry-run succeeds while gh is active as Joshua-Riley-ZD, so this repo no
    longer depends on the active gh account.
- [x] Merge phase2b-web-ui to master
  - Done 2026-09-10: merged with --no-ff (612dc7d) so the Phase 2B boundary stays visible, then
    re-ran install, 656 tests and typecheck on master before pushing over the new SSH remote.
    phase2b-web-ui is fully merged and can be deleted whenever you want.
- [x] Build the Slack import wizard (file_input + views.push)
  - Done 2026-09-10: `/import` runs the whole flow in Slack over the existing importer engine.
    72 new tests (728 total). Two deviations from the spec, both recorded in code: the steps use
    views.update rather than views.push, because a view_submission must be acked within 3 seconds
    and staging cannot finish in that budget (update also frees the 3-view stack ceiling); and the
    handler does not re-check declared type against content, because assertWithinLimits already
    owns that rule. Adds the files:read scope, so the Slack app needs a reinstall.
- [x] Recognize a bare time in a captured title (e.g. "Call Andre at 3:30") and set the due date from it, instead of leaving the task with no due — while keeping the title byte-exact
  - Done 2026-09-10: packages/task-core/src/capture-time.ts. Title is never touched -- `due:` is a directive and gets stripped, an in-title time is prose and stays. Needs a preposition (at/by/@) or an am/pm, so "Fix ratio 2:1" sets nothing. Bare times resolve to the next future occurrence. A `due:` token and a time combine: token picks the day, title picks the clock. The card states the inference rather than setting a date silently. Renamed off `findTimeInTitle` because Required test 18 forbids any task-core export matching /title|rename/i.
- [x] Import all my existing tasks — this needs to get functional immediately
  - Done 2026-09-10: batch 9a15b723-3912-4b16-b235-8ddac02fecbe, 21 tasks from the Workast export, 0 skipped / 0 review / 0 failed. All 21 titles verified byte-exact against the source file, including curly apostrophes, an em dash, $ amounts and 401(k). Space routing checked before writing: all 7 categories resolved, `Personal tasks` via the alias, the Milltown task came through as waiting. The 7 unassigned tasks are genuinely unassigned in Workast, not a mapping miss. Filled the real Slack ID into config/workast-mapping.json. Rollback: pnpm import-tasks -- --rollback 9a15b723-3912-4b16-b235-8ddac02fecbe
- [x] Map a channel to a Space from inside Slack, rather than editing config/channel-map.json and running a CLI command
  - Done 2026-09-10: `/tasks map` opens a native modal with a static_select of every Space, current one preselected, plus a "none" option that unmaps. A subcommand of /tasks rather than a new command, so no manifest change and no reinstall. mapChannelToSpace/unmapChannel moved into task-core and the web settings page now delegates to them instead of keeping its own copy.
- [x] In a channel already mapped to a Space, don't show the Space on each task row — the channel already implies it
  - Done 2026-09-10: the /tasks case was already covered by the grouping change (a Space heading suppresses the row-level Space). Added it for the /task capture card, and for redrawCard so ticking a checkbox does not make the Space reappear. An unmapped channel still shows Inbox, because that one IS worth knowing.
- [x] Delete Spaces from inside the web UI — Yoga Farm is one I don't want
  - Done 2026-09-10: deleteSpace in task-core, offered on /spaces behind a native details disclosure (two clicks, no client JS). Refuses Inbox and refuses a Space holding tasks including completed ones; removes its lists, channel mappings and aliases; clears import staging pointers but keeps the source text. One transaction. Yoga Farm deleted.
- [x] List Spaces in alphabetical order automatically
  - Done 2026-09-10: listSpaces now orders by the DISPLAYED name (regexp_replace strips 'Client - '). It was already alphabetical by the stored name, which is why it looked random: the client block sorted under C. Inbox stays pinned first.
- [x] Show Spaces as a vertical sidebar in the web UI, closer to the Workast setup, with things toggleable
  - Done 2026-09-10: components/Sidebar.tsx, a rail on My tasks / Waiting / History / Spaces. One CSS grid, stacks above the content below 820px. Counts only where non-zero. Reads the same spaceSummary the /spaces page uses so counts cannot disagree.

- [x] Bare `/task` opens the full capture modal
  - Done 2026-09-10: title, Space picker, new-Space text field, status, assignee, due, details. The one-line `/task <title>` fast path is untouched. Replaces a usage message that told you the syntax and made you type it again.
- [x] Create a Space
  - Done 2026-09-10: createSpace in task-core, reachable from the /task modal's "…or a new Space" field and from a form on /spaces. Idempotent on the name, slug derived and de-duplicated, seeds the standard two lists. Does not prepend 'Client - '.
- [x] BUG: the check mark in the web UI does not mark a task complete — it should
  - Done 2026-09-10: it was a readOnly checkbox next to a `hidden` submit button. A checkbox does not submit a form and this app ships no client JS, so nothing could reach the submit. Now a real submit button. Verified in a real browser: task_events shows completed/source=web at 21:09:00. curl cannot replay a React server action (the $ACTION_REF is unreconstructable), so it 500s and proves nothing.
- [x] Web UI: rework the top nav to match the Workast layout — clean, with My tasks / Due today, and Spaces in the left sidebar
  - Done 2026-09-10: brand + My tasks / Due today / Waiting / Completed, with Settings and the signed-in user pushed right. Active item is an underline rather than a filled pill (five filled pills read as buttons). Spaces left the top nav entirely — they are the rail. New /today route pins the due bucket.
- [x] Web UI: make Edit a modal in the centre or a pane that slides in from the right, instead of its own page
  - Done 2026-09-10: a right-side pane over a dimmed backdrop. Still a real route, not a dialog: the backdrop is a link back to the list, so closing needs no client JS and the URL stays linkable. Full width below 620px.
- [x] Web UI: inside a Space, show Open, then Waiting/Backlog, then Completed as toggleable (collapsible) sections
  - Done 2026-09-10: three `details`/`summary` sections with a CSS-only chevron and a count. Open and Waiting start expanded, Completed starts closed because it only grows. Three separate queries so each count matches its section exactly.
- [x] Web UI: drop the Spaces filter chips from My tasks, since the Spaces are all in the left sidebar
  - Done 2026-09-10: FilterBar now gets show={['search','status','due','assignee']} on My tasks. Also dropped the Space from each row's meta line on a Space page, where the heading already names it.
- [x] Web UI: use a circle check mark like Workast, green when complete, and strike through a completed task
  - Done 2026-09-10: same change. Hollow circle when open, faint tick on hover, filled green with a white tick when complete. Strike-through was already in the CSS.
- [x] Add aside to PATH if needed
  - Done 2026-09-10, decided AGAINST. /Applications/Aside.app/Contents/MacOS/aside is the Chromium browser executable, not the scripting CLI /browse drives: `--version` returns the Chromium string 152.0.7977.83, an unrecognised argument makes it launch and print "DevTools listening on ws://...", and the binary contains no repl/exec/snapshot subcommand strings. Putting it on PATH would make `command -v aside` succeed, so /browse takes the Aside branch, `aside repl` opens a browser window instead of running the script, the ASIDE_READY sentinel never appears, and the skill reports ASIDE_NOT_RUNNING and asks you to open the app — a loop that cannot resolve. Strictly worse than the current clean fallback to gstack's own browser. If the real Aside CLI is ever installed it will put itself on PATH and /browse will pick it up with no change here.
- [x] Work out what fix would make the scriptable aside CLI available to /browse, and whether it is worth doing
  - Done 2026-09-10, recommendation: DO NOT bother for this project. There is no `aside` binary in the app bundle or in ~/.aside/runtime/bin (which holds node/npm/npx/python/rg/pdf tools for Aside's own internal agent). aside.com documents no CLI. gstack expects `aside` on PATH and explicitly forbids the agent installing it ("NEVER run an installer, brew formula, or download for them"), so the fix is user-side: check Aside's own Settings for an "install command line tool" action, which is how most browsers and editors ship theirs. Not worth chasing here because everything under test is localhost behind the WEB_DEV_USER bypass, where Aside's only real advantage — the user's live logged-in sessions — buys nothing; gstack's bundled browser already found the dead checkbox, verified the fix against Supabase, and produced the reviewed screenshots. If real sessions are ever needed, /setup-browser-cookies imports them for a fraction of the effort.
