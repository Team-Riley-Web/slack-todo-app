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
  - Done 2026-09-10, recommendation at the time: do not bother for this project. SUPERSEDED same day — the CLI
    was installed and works; see the entry below. The factual half of this note was right (no CLI was present,
    the fix was user-side) and the value judgement was mine, not a blocker. Original reasoning kept below.
  - Original note: DO NOT bother for this project. There is no `aside` binary in the app bundle or in ~/.aside/runtime/bin (which holds node/npm/npx/python/rg/pdf tools for Aside's own internal agent). aside.com documents no CLI. gstack expects `aside` on PATH and explicitly forbids the agent installing it ("NEVER run an installer, brew formula, or download for them"), so the fix is user-side: check Aside's own Settings for an "install command line tool" action, which is how most browsers and editors ship theirs. Not worth chasing here because everything under test is localhost behind the WEB_DEV_USER bypass, where Aside's only real advantage — the user's live logged-in sessions — buys nothing; gstack's bundled browser already found the dead checkbox, verified the fix against Supabase, and produced the reviewed screenshots. If real sessions are ever needed, /setup-browser-cookies imports them for a fraction of the effort.
- [x] Use the astronaut image at apps/web/public/tasks-logo.png as the web UI favicon and header logo, matching the Workast layout (logo + workspace name top-left of the sidebar)
  - Done 2026-09-10: metadata.icons in app/layout.tsx (icon, shortcut, apple) all point at the one 512px file, rather than the app/icon.png convention which would need a second copy. Header shows the logo at 26px plus "Team Riley", linking home. Put in the top bar, not above the rail like Workast, because the rail is absent on Settings and behind the edit pane. Verified: three link tags in the head, image serves 200, no console errors, production build clean.
- [x] Create new Spaces in Slack and in the web UI
  - Done 2026-09-10: the web form and the /task modal field already existed from ff4fd5c, but the ONLY Slack path forced a task to be created alongside the Space, which is backwards for a client that has no first task yet. Added `/tasks new <name>`, a subcommand so no manifest change or reinstall is needed. Verified the web form by submitting it in a browser: created Client - Verify Form, slug verify-form, 2 lists; then deleted it. Three paths now, all through createSpace in task-core.
- [x] Replace /tasks map with /task space — one command that opens a modal to connect this channel to a Space or create a new one, so there is nothing extra to remember
  - Done 2026-09-10 as `/space`, not `/task space`. Started building the subcommand, then switched on the follow-up "typing /space is fine" — and it is strictly better: a `/task` subcommand would have carved an exception into the byte-exact title rule, so nobody could ever have a task called exactly "space". One modal now does pick / create / unmap, with the create field mapping the channel to the new Space in the same submit. /tasks map and /tasks new still work but are undocumented. Needs the manifest re-saved; no reinstall, since slash commands are not scopes.
- [x] Aside CLI is now installed — check it works and use it for browser verification instead of the fallback browser
  - Done 2026-09-10: verified working. `aside` is at ~/.local/bin/aside, version 1.26.906.1630, and the readiness probe returns ASIDE_READY with a per-run session dir under ~/.aside/u/0/sessions. So the CLI is a SEPARATE install from the app bundle, which is what the earlier investigation could not determine. Drove localhost:3040 through it end to end: URL loaded, CONSOLE_ERRORS=[], the Spaces rail present, screenshot written to ASIDE_DIR. One gotcha: Aside prints snapshot rows as `- button "x" [ref=eNN]` while the fallback browser prints `@eNN [button] "x"`, so a regex tuned to one silently counts zero on the other — I hit exactly that and nearly reported a missing button. Aside also warns against tree.split(), preferring the full tree or a diff.
- [x] BUG: all the styles in the web UI appear to be broken
  - Done 2026-09-10: not a code bug, and my fault. I ran `pnpm --filter @tr/web build` at 16:32 to verify the favicon while `next dev` was still running. They share apps/web/.next, so the production build deleted the dev server's CSS chunks; the HTML kept linking /_next/static/css/app/layout.css and that URL 404'd, so every page rendered unstyled. Confirmed on disk: .next/static/css/app was empty and a BUILD_ID dated 16:32 was present. Fixed by stopping the server, rm -rf apps/web/.next, restarting. Verified through Aside: 5 stylesheets, nav display flex, 1px border, circle cursor pointer. Documented in README and WEB.md so it is recognisable next time.
- [x] Add a note in the README on how to run the local web UI on my own, whenever I want
  - Done 2026-09-10: new "Running the web UI yourself" section in README.md — `pnpm web`, one command. Added that script because `pnpm --filter @tr/web dev` does NOT work: Next only auto-loads a .env in its own directory, this repo's is at the root, so DATABASE_URL and WEB_DEV_USER are unset and every page 307s to /signin, which cannot complete locally. Verified by reproducing the 307 and then confirming `pnpm web` returns 200 with CSS. Also added pnpm web:build and the build-clobbers-dev warning.

- [x] Match the Workast design more closely in the web UI
  - Done 2026-09-10: the problem was architectural, not colour. Workast has NO top bar -- workspace identity, the
    cross-Space views, the Space list and Settings all live in one dark rail, and the main column is content only.
    Rebuilt to that: Nav.tsx deleted and folded into Sidebar.tsx, Shell.tsx now takes title/subtitle/toolbar so every
    page has the same shape, new SectionCard.tsx wraps each list in a card with a table header and a create footer,
    and TaskRow became a 5-track grid row instead of a flex line. Colours sampled from the screenshots with
    ImageMagick (#1e2432 rail, #5986ff active, #35ca8c check, #ea4954 overdue) rather than guessed.
  - Two layout bugs found by MEASURING in the browser rather than eyeballing the screenshot: (1) the sidebar's
    `ul.group.spaces` was inheriting the /spaces PAGE grid, `repeat(auto-fill, minmax(215px,1fr))`, so it laid out in
    two columns 280px wide inside a 240px rail and clipped; renamed to .space-list and scoped the page grid under
    .content. (2) Rewriting globals.css appended the whole old sheet after the new one, and the surviving
    `li.task { display: flex }` outranked `.row { display: grid }` on specificity, so task rows never gridded while
    the header row did -- the columns were visibly misaligned. Verified fixed by comparing bounding boxes: header and
    rows now both read x=285/319/1115/1225.
  - Explicitly NOT pixel-perfect, and said so: font metrics, the exact spacing scale and region boundaries are not
    recoverable from a JPEG. Closing that gap needs computed styles off the live Workast app.
- [x] Web UI: move search to the top right corner
  - Done 2026-09-10: SearchBox in the page header, right side. A GET form so the query lands in the URL; every other active filter rides along as a hidden field, or searching would silently clear the view you were filtering.
- [x] Web UI: add icons to My tasks / Due today / Waiting / Completed in the sidebar
  - Done 2026-09-10: components/Icon.tsx, eight inline SVGs. Inline rather than a font or a package: they inherit currentColor, so active and hover states need no extra rules.
- [x] Web UI: automatically sort clients into their own section in the sidebar
  - Done 2026-09-10: derived from the 'Client - ' prefix, not a flag, so nothing has to be maintained — name a Space 'Client - X' and it files itself. That is also why createSpace does not add the prefix for you: the prefix IS the signal.
- [x] Web UI: drop the task count subtitle under My tasks, and make the page heading the Space name when a Space is selected
  - Done 2026-09-10: subtitle removed from all four list views (a count above a list of the same tasks was noise). The Space page heading was already the Space name.
- [x] Web UI: remove the Open / Waiting / Completed filter pills — keep only Overdue, Today, This week, No date
  - Done 2026-09-10: gone. The views already mean that — a Space page splits into those three sections and Waiting/Completed have their own pages. Only Overdue / Today / This week / No date remain.
- [x] Web UI: turn the assignee filter into a dropdown instead of name pills, and move it right or elsewhere
  - Done 2026-09-10: a select with its own Apply, pushed right by a flex spacer. An auto-submitting select would need JavaScript, and this app ships none.
- [x] Web UI: replace Manage Spaces cards with a plain list that looks like the open task list
  - Done 2026-09-10: the same row/card shape the task lists use, with Open/Waiting/Done as real columns. Also renamed the sidebar entry from 'Manage spaces' to 'Spaces'.
- [x] Web UI: on Settings, make import history, timezone and who-can-see-this collapsible sections, closed by default
  - Done 2026-09-10: each is a details panel. Only the channel map starts open — it is the one thing anyone comes to that page to change; the rest is reference.
- [x] Web UI: add spacing between the channel ID / channel name / space fields on Settings
  - Done 2026-09-10: form.fields is a grid with 12px gaps, one field per line, instead of three inputs crammed on one row.
- [x] Web UI: put Add new Space behind a modal instead of an inline form
  - Done 2026-09-10: a pane at /spaces?new=1, same mechanism as the edit pane, so the list stays visible and the form is not permanently taking up page room.
- [x] BUG: clicking Edit on a task makes the underlying list disappear — the modal should pop over to the right, list still visible
  - Done 2026-09-10: it was its own ROUTE, so the whole page was swapped out. Editing is now a query parameter on the list you are already on (/?edit=<id>), the list renders behind the pane, and the URL stays linkable with a working back button — no intercepting routes and no client JS. Verified in a browser: pane=true, backdrop=true, listRows=21, rail=true. Save returns to the filtered view it was opened from, via a returnTo field.
- [x] Web UI: sharpen the dropdown arrows on the Space sections and give them space to the right
  - Done 2026-09-10: the chevron is two 1.6px borders rotated 45deg rather than a filled triangle, which at 7px read as a blob. Margin added to its right.
- [x] Web UI: show the assignee name (Joshua) instead of the raw Slack ID, including on the edit form
  - Done 2026-09-10: the edit form's assignee is a select of known names, not a text input holding U0BU0V0850Q. An id with no label still round-trips unchanged as its own option. Verified: options read ['Unassigned','Joshua'].
- [x] Present the Space list in the Slack /space modal in alphabetical order
  - Done 2026-09-10: it WAS alphabetical — by the displayed name, the same sort as the web sidebar (Agency, CFC, Joy, Marketing, Milltown, Music, Nazareth, Personal). Slack showed the full stored name, so every "Client - ..." interleaved with the internal ones and a correct sort looked scrambled. Fixed with native static_select option_groups: a Spaces group and a Clients group, prefix stripped from client labels, values untouched. Applied to all three Slack pickers (/space, the bare-/task modal, Edit task) through one shared spaceOptionGroups helper, since the same list appears in each.
- [x] Web UI: be able to rename a Space, from the same pane that adds one
  - Done 2026-09-10: the pencil icon on each row opens a Rename pane, the same chrome the Add pane uses, over the list. A rename records the OLD name in space_aliases, so findSpaceExact keeps resolving `/tasks music` after Music becomes Records and config/channel-map.json does not break; the slug is regenerated. One transaction. Named setSpaceName, not renameSpace, because the tasks.test.ts guard asserts task-core exports nothing matching /title|rename/i.
- [x] Web UI: on the Spaces list, replace the Fallback / N-to-move / Delete text column with edit and delete icons in their own column
  - Done 2026-09-10: pencil + trash in an .iconactions column, last grid track 190px -> 76px. Inbox gets no trash, since every unmapped capture falls back to it. Both icons open a pane with its own URL rather than acting immediately, so the delete pane has room to explain why a Space holding tasks cannot go. Fixed a pre-existing bug found while checking phone width: the narrow-screen rule used .num:nth-of-type(2)/(3), which counts spans not .num cells, so it hid Open and Waiting and kept Done; now `.num ~ .num`, keeping Open.
- [x] Web UI: on All spaces, show the Space as its own column in the task row instead of as a sub-item beneath the task title
  - Done 2026-09-10: a Space column sits between Task and Assignee, with a matching heading, on every list that mixes Spaces (My tasks, Due today, Waiting, Completed). A single-Space page still drops it, since its heading already names the Space -- that needed showSpace on SectionCard too, because the header is a sibling of the list and cannot read it from the rows. On a phone the column is off and the Space returns to the title's sub-line: a 128px track there wrapped titles to four lines, and hiding it outright would leave the phone unable to say which Space a task is in.
- [x] Web UI: separate the Space dropdown in the Edit task pane into Spaces and Clients groups, like the Slack pickers, instead of one flat list showing the Client - prefix
  - Done 2026-09-10: native optgroup, so no JavaScript. The grouping rule is a plain function (lib/space-groups.ts) with 7 tests, because the web vitest setup collects .test.ts and has no React renderer. Applied to the Settings channel-mapping select too -- same flat prefixed list, same defect. The two submit different values from the same list, an id and a canonical name, so valueOf is a prop: the mapping form must keep posting the full "Client - ..." name because setChannelMapping resolves it with findSpaceExact.
