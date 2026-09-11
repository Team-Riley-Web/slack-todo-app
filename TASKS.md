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
- [x] Slack bug: ran /space then created a task in the finances channel. Both the Space and the task were created (visible in the web UI) but neither posted anything back in Slack, and the task was not connected to the Space
  - Done 2026-09-10: the app had never been invited to #finances, so chat.postMessage failed with not_in_channel and chat.postEphemeral would have failed identically. /task threw AFTER createTask; /space wrapped its confirmation in a bare `catch {}`. Both produced silence. Slash-command replies now go through response_url, which needs no channel membership, and a card that cannot be posted reports "saved, invite the app to see cards here" instead of vanishing. 13 new tests; verified 5 of them fail with the fix reverted.
  - The Space connection was NOT broken: the DB shows /space mapped #finances -> Finances at 22:23:33 and /task created the task in Finances 28 seconds later. Only the Slack reply was missing, which made it look otherwise.
- [x] Web UI: on a filtered-to-one-Space view (e.g. /?space=cfc-skincare) drop the Space from the task sub-line and put the Space name in the page title at the top instead of My tasks
  - Done 2026-09-10: filtered to one Space, that Space titles the page and leaves the rows entirely -- the new Space column as well as the sub-line, since the column would have repeated it just as pointlessly. Applied to all four filterable views (My tasks, Due today, Waiting, Completed); the section heading still names the view, so /today?space=x is not mistakable for /?space=x. An unknown slug falls back to the view's own title rather than naming a Space that is not there. 4 tests on spaceBySlug.
- [x] Implement the suggestions in /Users/joshuariley/Downloads/brand-spec.md
  - Done 2026-09-10: copied to docs/brand-spec.md so it can be read against the code. Five of the six tokens converted to exactly the hex already in globals.css -- the spec was sampled from this UI -- so the only colour change is the accent, which becomes the rail's cornflower. White on it is 3.34:1, under the 4.5:1 text floor, so --accent-strong (oklch 0.57, the lightest AA-passing point on the spec's own hue) covers text-on-blue on the light side; the cornflower stays the selection colour on the rail. Tokens now declared hex-then-oklch, and renamed to the spec's --surface/--border. Three type stacks added: display serif on the page heading, pane heading and rail team name; mono on code/pre/kbd/samp, which had no family at all before. Column labels darkened to --fg so metadata reads quieter than them, per the spec's rule 4 -- the other direction would have pushed the sub-line under 4.5:1. Fixed a dead `.pane-head h1` rule (both panes render h2). WEB.md updated.
  - Spec rule 4 also says metadata sits below task titles, which the last two tasks deliberately moved out to a column. Kept the newer instruction; the rule still holds for what remains in the sub-line.
- [x] Web UI: change the sidebar icons for Waiting and My tasks
  - Done 2026-09-10: My tasks is an inbox tray (was a ticked box, which said the same thing as Completed's checkmark one row below); Waiting is the pause bars inside a circle (bare bars read as two stray marks). Candidates were rendered in the rail's own dark context and judged at 16px: a circled check still read as Completed, a checklist went mushy, an hourglass collapsed to a blob. A clock lost deliberately -- Due today is already a calendar, and a second time-shaped glyph beside it would say "date" rather than "stuck".
- [x] Web UI: remove the "Local development user" line under Team Riley in the sidebar header - there is no prod setup at this time
  - Done 2026-09-10: the `who` prop existed only to render that one line, so it went too -- Sidebar, Shell, seven pages, and the `nav.rail .who` rule. requireUser() still runs on every page: it is the gate that redirects a signed-out visitor, so the call stays even where the return value is no longer read. /settings keeps its `user` binding, which it uses to mark "(you)" in the authorized list.
- [x] Web UI: make the Spaces and Clients sidebar groups collapsible
  - Done 2026-09-10: details/summary, the same mechanism the cards and settings panels use, since the app ships no client JavaScript. Open by default. Measured with checkVisibility(): closing Spaces hides 8 links, Clients 5, Reports 4, leaving the 2 foot items. getBoundingClientRect was useless as a probe -- Chrome gives closed details content content-visibility:hidden, which preserves the cached layout box, so everything still measured as visible.
- [x] Web UI: add a collapsible Reports group to the sidebar, like the Workast reference (My tasks, Due today, Assigned to me, Completed by me)
  - Done 2026-09-10: the four cross-Space views that were an unlabelled list at the top of the rail are now a Reports group that collapses like the other two. Both queue entries were one change in one file.
  - Did NOT add the reference's "Assigned to me" or "Completed by me". Assigned to me is a real distinct filter (My tasks shows unassigned tasks too) but highlighting it correctly needs the active assignee filter inside the rail, which means threading filter state through Shell and seven pages; without that it never highlights and My tasks highlights instead. Completed by me has no data path -- there is no completed_by column, only task_events.actor_id. In a one-person workspace both largely duplicate My tasks and Completed. Left for a decision rather than invented.
- [x] Web UI: fix the bad alignment on an empty task list - the Task column header does not line up with the empty-state text, and the header row indent is off
  - Done 2026-09-10: measured three left edges in one card -- title 306, "Task" 319, empty message 269 with no padding at all. The column header no longer renders over an empty list (labels for columns that are not there), and the empty message starts on the card title's edge, since with the header gone those two are the only text in the card. Offset written as the summary's own arithmetic, 16 + 13 + 8, not a magic 37.
  - Also normalised the toolbar: chips 30px, select 32px, Apply 35px, all vertically centred, so nothing was strictly misaligned but no two adjacent controls shared a top or bottom edge. Now one 34px height. `height`, not `min-height` -- the button's own padding made it 35 and a minimum left it a pixel taller than its neighbours.
  - Populated rows were already exact: header and row cells agree at 285/319/827/955/1065. Left alone.
- [x] Web UI: align the card title, the Task column header and the task title to one left edge - on a populated card they sit at three different indents
  - Done 2026-09-10: the summary is a grid whose first track is the tick column, so the chevron sits above the circle and the title starts where task titles start. As a flex line it was 13px left of them (chevron + gap rather than a full tick column). Tick width is now one variable read by the rows, their header, the summary and the empty message, so the phone's narrower 30px moves all four together. Measured 319 for all five text edges on every task card.
  - The Spaces card is deliberately left as it is (title 306, columns 285): its rows have no tick column, so the same track would push its title 34px right of the column it labels, and aligning the other way would need the chevron outside the card's padding. Fixing it properly means a 34px empty gutter on every space row -- worth doing only if the difference bothers you.
- [x] Web UI: give task rows a slight alternative background colour so they read as distinct rows
  - Done 2026-09-10: zebra striping on task rows via a new --surface-alt token, which also replaces the bare #fafbfc the column header band was using -- one named tone, two uses, no invented colour. Strength picked by rendering four side by side: the header's old 1.2% was invisible as a stripe, 3% read as banding; 2.4% (#f6f7f9) is where a row is trackable and the list stays quiet.
  - Task rows only. The Spaces list is short and mostly counts, so striping it would be decoration rather than help. nth-child works because the column header is a sibling of the ul, not a child, so the first task row is always odd.
- [x] Web UI: drop the serif display font - use the sans-serif body font for the page heading, pane heading and the Team Riley name in the rail
  - Done 2026-09-10: --font-display deleted rather than redefined, so no rule reads a face the app does not use. Reverted the sizes and weights I had raised to suit the serif's smaller apparent size: page heading 21px/600 back to 20px/650, team name 16px/600 back to 15px/650. Verified no element anywhere resolves to a non-sans serif family.
  - This overrides docs/brand-spec.md, which lists a display serif. Recorded in WEB.md and in a comment on the token block so a future session does not re-apply it from the spec.
- [x] Web UI: give the filter pills (Overdue, Today, This week, No date) light colours
  - Done 2026-09-10: each pill is a light tint of a hue that already means something here -- --overdue's red, --soon's amber for the week ahead, --accent's blue for today, and a neutral for no date. Background L 0.955 against label L 0.46 on the same hue puts every pair near 6.4:1, so a tinted pill reads no harder than the plain one. Selected still goes solid blue whatever the pill's tone: one colour meaning "on" beats four.
- [x] Web UI: add space between the Assignee label and its select
  - Done 2026-09-10: the label was nested inside the control's <label>, so only a collapsed text space separated them. It is its own element now, 8px clear of the dropdown.
- [x] Web UI: remove the Apply button - selecting an assignee should update the list on its own
  - Done 2026-09-10: a <select> cannot submit its own form without JavaScript, which is why the Apply was there. Replaced it with a details/summary dropdown whose options are LINKS -- picking one navigates and the list arrives filtered, no Apply and still no script. It closes itself, since following a link re-renders the page. Verified 20 rows -> 14 on picking Joshua, with the button reading Joshua and Clear appearing.
  - The Apply on /history stays: it submits the From/To date inputs, which cannot self-submit either, and it is a different control pair from the one in the screenshot.
- [x] Web UI: move the task sub-line metadata (waiting, age, source) into its own column - no metadata under the task title at all
  - Done 2026-09-10: nothing renders under a task title now. "Waiting on" and "Age" are real columns (one `showWaiting` flag adds both -- what a task is stuck on and how long are the same question), used by /waiting and by a Space page's Waiting section, which would otherwise have been the one place a blocker was invisible. Four grid templates, matching the four cell combinations actually rendered. Header and rows verified on the same template on every list page.
  - Dropped "from slack" on /history rather than giving it a column: it was the same text on every row, and the edit pane's History table already records the source. Phone keeps the Space as an 84px column, since there is no sub-line left to fall back on.
- [x] Web UI: clicking a Space in the rail while on a report (e.g. Waiting) keeps that report selected, so a Space with 6 open tasks shows nothing - switching to a Space from a report should go to My tasks for that Space
  - Done 2026-09-10: Space links always open /?space=<slug>. The per-page railPath that steered them existed for nothing else, so it is gone from Shell and six pages. "All spaces" is now current only on My tasks itself -- it had lit up on every report with no Space filter, next to the report's own highlight, while linking away from that report. Verified on all four reports.
- [x] Web UI: My tasks should show Open AND Waiting on the same screen, with Waiting below
  - Done 2026-09-10: a Waiting card below Open, with the Waiting on / Age columns. Both halves come from the same query with an explicit status each, so the due chips, assignee, search and Space narrow them identically -- waitingTasks() ignores the due filter, so using it would have let "Overdue" narrow Open while leaving Waiting untouched. Verified: all 20 open + 1 waiting; Milltown 0 open + 1 waiting (it showed nothing before); Overdue 0 + 0.
- [x] Web UI: make the task list columns sortable
  - Done 2026-09-10: every column label on every task list is a link that orders by it; clicking the active one reverses it. Sort rides in the URL (?sort=&dir=) like every other filter, so a sorted view is linkable, the back button undoes it, and it needs no JavaScript. The rule lives in lib/sort.ts with 15 tests: displayed values (a Space without "Client - ", an assignee's name), empties last in BOTH directions, stable ties, and a completed task sorts by the completion date its column shows. Search and the history date form carry the sort; it does not summon the Clear chip, since it narrows nothing.
  - Also fixed: header labels were two colours -- Space/Assignee/Due date grey, Task/Waiting on/Age dark -- because the value colour rules outranked the header's. All labels --fg now.
- [x] Web UI: the per-Space count in the rail should include waiting tasks, not just open
  - Done 2026-09-10: each Space and All spaces now count open + waiting. Milltown Cabinets went from no number to 1; All spaces from 20 to 21. The counts now agree with My tasks, which lists both since the task before last.
- [x] Web UI: add a New Task button in the top right of all views, as detailed in brand-spec.md
  - Done 2026-09-10: already built in another session -- "+ New task" top right of every view, opening a NewTaskPane at ?newTask=1. Verified rendering, not just present in the source.
- [x] Web UI: give the "Wait" button an outline in its non-hovered state too, not only on hover
  - Done 2026-09-10: the border was `transparent` until the row was hovered, so the label read as text and the only way to find out it was a control was to mouse over it. Outlined at rest now; hover deepens the border and fills it. On a striped row the button drops its white fill and keeps the outline, or it read as a white patch. Also gained a focus ring, which it never had.
- [x] Web UI: give the task list column header bar more visual distinction - darker background
  - Done 2026-09-10: the header had been sharing --surface-alt with the zebra stripes, which capped how distinct it could get -- any darker and every second row darkened with it. It has its own --header-bg now, 4.5% down from the surface (oklch 0.955) against the stripe's 2.4%. Picked by rendering four strengths beside the lighter stripe from the next task; 0.945 read heavy, 0.955 reads as a header. Labels stay --fg at 13.3:1.
- [x] Web UI: reorder the due pills to Today, This week, Overdue, No date
  - Done 2026-09-10: reordered. The order now reads as a horizon -- today, the week, what slipped, what was never dated -- where Overdue leading put the exception first and today's work third.
- [x] Web UI: the edit task pane should animate smoothly in on open and out on save
  - Done 2026-09-11: both directions now. The entrance was already CSS. The exit works by animating the pane out BEFORE it is taken away -- PaneShell adds `.leaving` on a close click or a submit, and only then lets the navigation happen. An element that no longer exists cannot be animated, so the trick is simply to animate it while it is still there.
  - Closing (x, Cancel, backdrop) holds the client-side navigation for the 150ms animation, because that navigation is fast enough to cut the animation off. Saving does NOT hold anything: the server action runs immediately and the exit plays underneath it. That turns out to matter a lot -- the save POST measured 3044ms because of the Slack card redraw, so the pane used to sit frozen on screen for three seconds; it now leaves at once.
  - Gave up on React's <ViewTransition>, which is built for this, and proved why rather than assuming: a probe component logging `typeof ViewTransition` reported undefined on BOTH the server and the client even with Next's experimental.viewTransition flag enabled. The flag swaps Next's own vendored internals, not what app code imports. Recorded in PaneShell so nobody retries it.
  - This adds the app's first client component, ~30 lines, no state and no data. Verified it degrades: the close controls are still real <a href> links and the form is still a real POST form, so with JavaScript off everything works exactly as before, minus the motion.
- [x] Web UI: the search box needs the icon on the right and the border-within-a-border fixed
  - Done 2026-09-10: icon moved after the input. The doubled border was a specificity tie -- `.search-field input` and the global `input[type="search"]` rule score the same, and the global one sits later in the file, so its border and background won and drew a second field inside the first. Fixed by naming the type in the scoped selector to win on specificity rather than order, plus appearance:none to drop WebKit's own inset search decorations.
- [x] Web UI: when the assignee box is open and I click out of it, it should close
  - Done 2026-09-11: it was a `details`/`summary`, which has no light dismiss -- only its own summary can close a details, so clicking away left the menu hanging open over the list. Open state is a checkbox now, because ANY label pointing at a checkbox can uncheck it: a full-viewport label behind the menu closes it from a click anywhere outside. Still no JavaScript.
  - The checkbox sits off-screen rather than `hidden`, since a hidden input cannot be focused and the control has to stay keyboard-operable; its focus ring is drawn on the visible button.
  - Verified each behaviour: closed at rest, opens on click, a click over a task row lands on the backdrop and closes it, the button toggles it shut, the control is focusable and Space opens it, and choosing a name navigates, arrives closed, and leaves the button reading that name.
- [ ] Launch a production version ###productiontask and Aside browser
- [x] Need to add Rachael as an Assignee U0BT6HDBYBC
  - Done 2026-09-10: only ONE assignee was configurable -- the DEFAULT_ASSIGNEE_SLACK_ID / DEFAULT_ASSIGNEE_LABEL pair -- so a second person needed a map, not a value. New ASSIGNEE_LABELS env var (`id=Name,id=Name`), parsed by task-core so the web app and the Slack app cannot disagree about it; 12 tests. The old pair still works and still names the default assignee, so an existing .env keeps running untouched.
  - The filter dropdown used to list only ids already ON tasks, which would have hidden Rachael until someone had already given her work -- backwards, since you filter to a person to see what they have. It lists everyone configured now, plus any id in use that nobody named (shown as the raw id, deliberately ugly: it reads as something to configure). Verified she appears in the filter and the edit pane; ASSIGNEE_LABELS set in .env, documented empty in .env.example.
- [x] Make alternating row color lighter - background: oklch(0.99 0 0 / 1)
  - Done 2026-09-10: --surface-alt set to the exact value asked for. It is a neutral grey rather than the faintly blue tint it replaced, and 1% down from the surface where the old one was 2.4%. That works now only because --header-bg was split off in the earlier task and carries the job of looking distinct; the stripe just has to separate a row from its neighbour.
- [x] make "This Week" pill green; capitalize Week
  - Done 2026-09-10: label capitalised, tone moved from amber to green on hue 160.5 -- the hue of --done (#35ca8c), so the app has one green rather than a second invented for a pill. Label measures 5.6:1 on its own fill. The comment explaining the tones was rewritten: it claimed amber meant "coming up soon", which is no longer why that pill is the colour it is.
- [x] Web UI: verify the New Task flow is set up properly - open the pane, create a task end to end, check every field and the error paths
  - Done 2026-09-10: verified by using it, not by reading it. Button and pane on all 8 views including /settings and /spaces; the active Space is preselected (/spaces/agency -> agency) and closing returns to the filtered view it was opened over. Created a task with title "ZZ probe — Neil's *$100* check-in": stored byte-exact through the em dash, curly apostrophe and *$100*, right Space, due 15:30 local written as 21:30Z. Empty title reopens the pane over the same filtered view with "A task needs a title." and keeps the Space. Probes deleted afterwards.
  - Found and fixed a real divergence: the pane had NO assignee field, so it sent nothing and every web-captured task came out unassigned -- while the identical task typed as `/task` in Slack was assigned to the default. Where you typed it decided who owned it. The action already read assigneeId; only the field was missing. Added, preselected with the default, which also makes Rachael reachable from the web -- verified by creating a task assigned to her.
  - Still missing next to the Slack modal, deliberately NOT added unasked: Details, and a status choice (Slack offers waiting at capture). Say the word if you want either.
- [x] Design the login screen to match the rest of the page - use the logo
  - Done 2026-09-11: it was a bare `.narrow` column -- a heading, a sentence and a button floating on white, with nothing on it from the app it opens. It is a card now, and the card's top band IS the rail's workspace header: same graphite, same 6px radius on the mark, same team name at 15px/650. That strip is the most recognisable thing in the interface, so reusing it is what makes the login read as the same product.
  - The logo is 40px here against the rail's 30. In the rail it is chrome beside a whole interface; on this page it is the only thing naming the product, so it gets to be legible rather than merely present.
  - The button is full width at 40px with the Slack mark, in white rather than Slack's four colours -- every other glyph in the app is a single colour inheriting from its label, and a four-colour mark would be the only multicoloured thing in the interface. Kept out of Icon.tsx on purpose: that set is one stroked path on a 24 grid, and this is four filled lozenges on Slack's 122.8 grid.
  - The access note drops to the --header-bg footer tone instead of sharing the button's white, so help stops competing with the one action. Centred in the viewport rather than pushed down by a 15vh margin, which had it sitting high on a laptop; verified at 375, 768 and 1280.
  - `.narrow` is gone -- this page was its only user.
- [x] Auto-capitalize the first letter of all tasks moving forward
  - Done 2026-09-11: new `capitalizeFirstLetter` in `packages/task-core/src/capitalize.ts`, applied in `createTask` and `editTask` — the two title write paths. Put in task-core rather than at each boundary because there are eight creation call sites (two Slack surfaces, the web pane, two REST routes, two MCP tools, the importer) and seven want it; one enforcement point means a surface added later cannot forget.
  - It is deliberately timid, because the failure mode is rewriting your own words. It changes at most ONE character and declines whenever capitalising would be a guess: a word carrying its own capitals (`iPhone`, `eBay`, `macOS`, `jQuery`), an identifier (`src/index.ts`, `github.com/…`, a URL, an email), or anything not opening with a lowercase letter (`3 quotes`, `#productiontask`, `🔥 urgent`). `toUpperCase`, not `toLocaleUpperCase`, so a Turkish locale cannot turn `i` into `İ`.
  - The importer opts out via a new `preserveCase` flag: an import reproduces records someone already wrote, and its idempotency key is derived from the source title, so tidying it would make a re-import look like a new record and duplicate it.
  - This narrows a real guarantee, so I did not just swap strings in the tests: five "byte-exact title" guards in task-core, MCP, the REST API and the web ops layer were rewritten to assert the new contract precisely — first letter capitalised, every byte after it untouched. Markdown, curly apostrophes, em dashes and emoji still survive the round trip. 24 new tests; full suite 1068 passing.
  - Verified against the live Supabase database with throwaway probes: `zz probe — check neil’s *$100* invoice 🚀` stored as `Zz probe — …` with everything after the first letter intact; `iPhone`, `src/index.ts` and an already-capitalised title untouched; the edit path capitalises too. Probes deleted.
- [x] Create task pane should show all the same fields as Edit task - needs Waiting on and Details options available
  - Done 2026-09-11: the New task pane was missing three fields Edit had — Status, Waiting on, Details. All three added in Edit's own field order, so the two forms read the same way top to bottom. Verified against the running app: both panes now render an identical set of input names (`title, status, assigneeId, dueAt, waitingOn, details`), differing only where they must — `spaceSlug` vs `spaceId`, and `taskId` on edit.
  - Status offers Open and Waiting / blocked, NOT Completed. That matches the Slack capture modal, which has always excluded it: a task that is already done is an edit, not a capture. `createTaskOp` rejects `completed` outright, so a hand-built POST cannot get around the missing option.
  - "Waiting on" without a Status field would have been incoherent — the placeholder literally says "only used when the status is waiting" — which is why Status came along even though only two fields were named.
  - Status and details are applied through `moveTask` and `updateTaskDetails` after `createTask`, not smuggled into the insert, copying what `capture-modal.ts` does so each change is its own audited event. A task captured as waiting reads as created-then-moved in its history on both surfaces; there is a test asserting exactly that event sequence.
  - Empty Waiting on / Details store NULL rather than blank strings, matching how the edit form reads the same fields. 7 new tests; full suite 1074 passing; `pnpm web:build` clean.
- [x] Priority system: add priority (P0/P1/P2/P3/null) to the task data model with migration, validation on every create and update path, and priority-first shared sorting (P0 → P1 → P2 → P3 → unprioritized) in the task-query layer — see docs/specs/priority-system.md
  - Done 2026-09-11: migration `011_task_priority.sql` adds a nullable `priority text` with a CHECK on P0-P3, plus `tasks_status_priority_idx (status, priority NULLS LAST)` so the index can serve the sort. Applied to Supabase: all 43 existing tasks came through as NULL with no backfill and no rewrite. No DEFAULT on purpose — 'P2' would have been a claim about historical tasks nobody actually made.
  - Stored as the label, not an integer rank: 'P0' < 'P1' < 'P2' < 'P3' sorts lexically in exactly rank order, so `ORDER BY priority NULLS LAST` IS the required ordering. No CASE expression, no lookup table, and no way for the display name and the sort key to drift. A test asserts the lexical sort and the rank sort agree.
  - `TASK_ORDER_BY` in `queries.ts` is the single ordering — priority, then the previous due-date-then-creation behaviour within a level. Slack, `/tasks all`, both scheduled digests, the web lists, REST and MCP all inherit it by going through `listTasks`; nothing sorts for itself. Tests assert it reaches `listOpenTasksBySpace` and both daily digests.
  - `parsePriority` is the one coercion point: absent, null and '' all mean Unprioritized (a form sends '', JSON sends null), and anything else throws rather than silently becoming null — a typo'd P7 landing as "no priority" would be indistinguishable from a task nobody prioritised. Validated at create and edit; the column CHECK is the outer guard, with a test that bypasses task-core to prove it.
  - Found and fixed an unrelated live bug on the way: `pnpm migrate` never loaded `.env`, so with no DATABASE_URL exported it migrated a throwaway in-memory PGlite and printed "migrations applied". WEB.md names that command as the pre-deploy step, so it was a silent no-op that would let a deploy proceed against an unmigrated database. It now loads `.env` (same shape as the `web` script) and prints its target: `migrations applied to aws-0-us-east-1.pooler.supabase.com:6543/postgres`, credentials stripped.
  - 21 new tests; full suite 1096 passing.
- [x] Priority system: parse P0-P3 case-insensitively out of Slack task capture text, strip the token from the title, store as structured data — P01 and unrelated text must not match
  - Done 2026-09-11: `parseCapture` now lifts a priority out of the text alongside the existing `due:` handling, so `/task P0 Fix Stripe checkout` stores a P0 task titled "Fix Stripe checkout". Case-insensitive, stripped from the title, stored structurally.
  - **Leading token only**, matching the strictness `due:` already has (trailing only). "P1", "P2" and "P3" are ordinary text — "Order 20 P2 cable ties", "chase the P1 visa application", "replace the P3 bracket" — and a parser matching anywhere would silently delete words out of titles. A title practically never OPENS with a bare "P2 ", so that one position is unambiguous. Tests cover all four of those phrases staying intact. If you want trailing (`Fix checkout P0`) too, say so — it is a small addition, just not a safe default.
  - `P01`, `P4`, `PO` and a bare `P` do not match: the regex requires whitespace after the token, so the "1" in "P01" defeats it. `/task P0` alone stays a task called "P0" rather than a priority with nothing to apply to. Composes with `due:` and with a clock time in the title.
  - Also added a Priority select to the Slack capture modal (the bare `/task` path), built from the shared `PRIORITIES` constant so it cannot offer a value task-core would reject. Optional with no initial option — "no priority" is the common answer and should not need deselecting. Without this the modal would have been the only capture surface that could not set priority, recreating the "where you typed it decides" divergence the assignee field already got caught by.
  - 9 new parser tests; full suite 1105 passing.
- [x] Priority system: show [P0] style priority in Slack task rendering, keeping the compact checkbox UX
  - Done 2026-09-11: `[P0] ` is prefixed to the checkbox label, so a row reads `☐ [P0] Fix Stripe checkout` exactly as the brief's example does. Unprioritized tasks show nothing rather than a "None" tag — a list of mostly-unprioritized work should not grow a column of noise. Native checkbox untouched; nothing else was added to the row.
  - The tag had to come OUT of the title's character allowance, not on top of it: Slack rejects the whole message if an option label passes 75 characters, and `[P0] ` costs five. `truncateLabel` takes a budget now, and `titleBudgetFor` is shared with the "Full title:" notice so the two cannot disagree about whether a title was clipped. Tested at 200 characters with and without a priority.
  - On a completed task the strikethrough wraps the title only — `[P2] ~Done thing~` — so a finished P0 still reads as a P0 instead of struck-through noise.
  - The tag also goes into the plain-text fallback, so a Slack notification preview and the message it previews do not disagree about what is critical. Both scheduled digests inherit this automatically; their tests now assert `[ ] [P0] Critical` in priority order.
  - 7 new rendering tests; full suite 1112 passing.
- [x] Priority system: add a priority select (P0 Critical / P1 High / P2 Medium / P3 Low / No priority) to the Web UI create and edit task panes
  - Done 2026-09-11: a Priority select in both panes, same position in each, rendering "No priority / P0 — Critical / P1 — High / P2 — Medium / P3 — Low". Options are generated from the shared `PRIORITIES` constant and `priorityChoice`, so neither pane can offer a value task-core would reject, and the label wording cannot drift between the two.
  - "No priority" is an explicit option rather than a blank — it is the common answer, not an absence — and it submits `''`, which `parsePriority` reads as null. That is why '' and null had to mean the same thing at the domain layer.
  - Added `InvalidPriorityError` to the web error describer. Without it a hand-built POST carrying `P7` would have thrown past `createTaskOp`/`editTaskOp` and become a 500 instead of a sentence in the pane.
  - Verified against the running app, not just the source: both panes render the select; setting a real task to P0 through `editTask` and reloading shows `<option value="P0" selected>` in the edit pane; reverted to null afterwards.
  - 5 new tests; full suite 1117 passing; `pnpm web:build` clean.
- [x] Priority system: add a Priority column with compact colored pills to the Web UI task lists, using the existing design tokens rather than arbitrary colors
  - Done 2026-09-11: a Priority column sits immediately right of the title, so an eye running down the titles catches a P0 without crossing the row. Sortable like every other column. Unprioritized shows an em dash rather than a "None" pill — the assignee, due and waiting-on cells in the same row already use one for "nothing recorded", and a pill on every row would stop meaning anything.
  - No new colours. P1/P2/P3 follow the house chip recipe exactly (fill L 0.955, label L 0.46, border L 0.92, one hue) on hues taken from tokens that already exist: --soon (43.0), --accent (266), the neutral (264.4). Measured 6.54 / 6.39 / 6.25:1 — the file cites ratios, so I computed them rather than eyeballing. P0 deliberately breaks the pattern and is FILLED on the --overdue hue (21.1), white on it at 6.02:1: four tints of rising chroma all read as the same weight in a scanned column, and "critical" has to outrank "high" at a glance.
  - The row grid is positional, so the new track went into all four desktop templates plus the mobile pair. 52px left the 8-character "Priority" label butting into "Space"; 64px reads properly.
  - **Priority is hidden on mobile**, alongside assignee/due/age. It looks like dropping the most important signal and is not: the list is priority-ordered everywhere, so on a phone the top row IS the critical one. Keeping it cost 44px off a title column already wrapping titles to six lines at 375px, and the header collided with "Space".
  - A test I wrote caught a real bug in my own first pass: `priorityRank` returns 4 for null, which is a number, so the generic empty-sorts-last rule never fired and descending floated every unprioritized task to the TOP. Fixed by returning null for unprioritized and the rank for the rest.
  - Verified visually in a real browser at 375/768/1280, not just in markup — screenshots in `.gstack/browse-reports/2026-09-11-1218/`. Probe priorities set on four real tasks to see every pill, then cleared; 0 tasks carry a priority now.
  - 2 new sort tests; full suite 1119 passing.
- [x] Priority system: expose and accept priority in the MCP and REST API task representation, keeping existing consumers that send no priority working
  - Done 2026-09-11: the representation needed no work — both surfaces return task-core's `Task` directly, so adding the column to the model put `priority` on every task MCP and REST return, with no second interpretation anywhere. Accepting it meant one new optional argument on each of the four create paths: `create_task` and `create_task_for_context` (MCP), `POST /tasks` and `POST /context/:channelId/tasks` (REST).
  - Settable at creation only, exactly like the title. No `set_priority` tool, no priority key on `move_task`, and a test asserts the tool list still matches nothing like /edit|rename|update_task|set_title|set_priority/. Hermes can read and set-on-create; it cannot re-prioritise your work.
  - Invalid values are rejected, not coerced: MCP throws, REST returns 400 `invalid_priority` (added to the Fastify error handler so it is not a 500). A mistyped P7 becoming "unprioritized" would be indistinguishable from a task nobody prioritised.
  - Backwards compatible by construction — omitting priority is valid everywhere, and both surfaces have a test proving a payload with no priority still returns 201 with `priority: null`.
  - `MCP_CONTRACT.md` updated: priority added to both create rows and a new section covering the values, the set-at-creation-only rule, the rejection behaviour, and the shared priority-first ordering.
  - 11 new tests across MCP and REST; full suite 1130 passing.
- [x] Expose the existing MCP tools over authenticated remote HTTPS (MCP Streamable HTTP) at /mcp so Hermes Managed can connect without cloning the repo — keep stdio working for local dev, share one set of tool definitions, bearer auth via TASKS_MCP_TOKEN, preserve the eight-tool contract and every determinism guard — see docs/specs/remote-mcp.md
  - Done 2026-09-11. **The brief's "eight-tool contract" does not exist.** `MCP_CONTRACT.md` line 8 said "Eight tools" while line 181 of the same file said "Twenty tools in total", and `TOOL_NAMES` has 20. The eight was stale from phase 1. I preserved the real 20 and corrected the doc rather than inventing a subset.
  - Structure: `tools.ts` untouched (canonical), new `server.ts` holding `createMcpServer(db)`, `index.ts` reduced to the stdio transport, new `http.ts` for Streamable HTTP. Both transports call `createMcpServer` and nothing else, so a tool cannot exist on one and not the other — a test asserts the two name lists are equal, and both were verified live at 20 tools.
  - Transport: the SDK's own `WebStandardStreamableHTTPServerTransport` (SDK 1.30.0) in stateless mode, `sessionIdGenerator: undefined` + `enableJsonResponse: true`. Not a pseudo-REST endpoint. **My first pass had a real bug**: with SSE framing the route returned 200 `text/event-stream` with an EMPTY body, because a serverless invocation ends when it returns and cannot keep feeding a stream. JSON responses are a supported part of Streamable HTTP, not a workaround, and they fit a request/response host exactly.
  - **Deployment: `/mcp` lives in `apps/web`, not `apps/api`.** The brief preferred apps/api, but that app has no deployment of any kind — no Dockerfile, no platform config, it runs locally on :3030 — so an endpoint there would have no public host for Hermes. apps/web is the only deployed surface and already terminates HTTPS. Routed at `app/mcp/route.ts`, giving exactly `/mcp`, plus `/mcp/health`.
  - Auth: `TASKS_MCP_TOKEN`, constant-time compare, `401 {"error":"unauthorized"}` with no hint whether the token was absent, wrong-length or merely wrong, and no echo of what was sent. Unset denies everything. The database is not touched until a request authenticates. Separate from `API_TOKEN` so MCP access can be revoked independently — a determinism test asserts the REST token is NOT accepted here.
  - Health at `/mcp/health`, unauthenticated, no database, no task data: `{ok, service, transport, tools, configured}` where `configured` says only that a token exists. Its own path because GET on `/mcp` belongs to the MCP protocol.
  - Security posture intact: no edit/rename/update_task/set_title/set_priority tool on either transport (asserted in `tests/determinism.test.ts` against the exported name list), mutations still UUID-only with no fuzzy title lookup, unknown explicit Space still rejected, `create_task_for_context` still reports `channel` vs `explicit`, priority exposed from the canonical task-core model with no second interpretation.
  - Verified live, not just in tests: health 200; `/mcp` 401 with no token and with a wrong token; a real `initialize` handshake; `tools/list` returning 20; `get_task_counts` returning real counts across 11 spaces; and `pnpm mcp` over stdio still returning the same 20 tools. Probe token never written to `.env`.
  - 19 new tests (17 http + 2 determinism); full suite 1149 passing across 65 files.
  - Read capability for Hermes is already sufficient for every use named in the brief — briefings, client summaries, open counts, waiting/blocked, Personal context, priority-aware analysis — via `get_task_health`, `get_open_counts_by_space`, `get_this_week`, `get_completed_between`, `get_task_counts`, `list_waiting`, `list_tasks`, `list_tasks_for_context`. No contract addition needed.
  - Re-validated 2026-09-11 against a second, more detailed brief. Two real gaps found and closed: (a) nothing compared MCP_CONTRACT.md's tool table to `TOOL_NAMES` — which is exactly how "Eight tools" survived in the doc while the code had twenty — so there is now a test parsing the doc's table and asserting set equality, plus one asserting the prose count and the five-writer/fifteen-reader split; (b) no test proved the HTTP path keeps the token out of the console, so one now captures console.log/error/warn across authorized, unauthenticated and bad-token requests and asserts the token appears in none of them. 22 tests in http.test.ts; full suite 1140.
- [x] Make the This Week pill background this green: oklch(0.96 0.03 160.5 / 0.6)
  - Done 2026-09-11: `a.chip.tone-week` background set to exactly that value in `globals.css`. Label and border left alone — only the background was asked for. Verified in a real browser: the computed style reads back `oklch(0.96 0.03 160.5 / 0.6)`.
  - Checked the alpha before applying it, since the fill is now translucent and the label sits on whatever shows through. It measures 5.97:1 over the card and 5.90:1 over a zebra stripe, slightly BETTER than the 5.64:1 the opaque fill gave, so the transparency costs no legibility. Updated the comment, which still claimed 5.6:1.
  - Note, not a change: "Today", "Overdue" and "No date" are still opaque at L 0.955, so This Week now reads a touch paler than its neighbours. That is what the value asked for; say the word if you want the other three softened to match.
- [x] Sidebar should roll into a hamburger menu on mobile
  - Done 2026-09-11: below 860px the rail is now an off-canvas drawer behind a hamburger. It used to become a full-width strip ABOVE the content, so every page on a phone opened with the entire navigation — Reports, Spaces, Clients, footer — and you scrolled past all of it to reach your tasks. Off-canvas costs one tap and gives the whole screen to the work.
  - No JavaScript, same mechanism as the assignee menu: an off-screen checkbox holds the open state, a label opens it, and a full-viewport label behind the drawer closes it from a tap anywhere outside. The three controls are siblings of `<nav>`, not children, because `#rail-state:checked ~ nav.rail` cannot reach into an element. Navigating closes it for free — every page is a fresh server render, so the checkbox starts unchecked.
  - The checkbox is off-screen rather than `display:none`, because a hidden input cannot be focused and the menu has to stay keyboard-operable; the focus ring is drawn on the visible button. New `menu` icon in `Icon.tsx` on the same 24 grid and 1.6 stroke as the rest of the set.
  - Two things I fixed after looking at it: the hamburger sat squarely on the drawer's workspace logo when open (the drawer's header now has 56px of left padding, so the button becomes its close control and keeps its focus ring), and the page behind an open drawer still scrolled (`body:has(.rail-state:checked) { overflow: hidden }` — the checkbox is already the source of truth and `:has()` is the one selector that can read it from an ancestor). Transitions are disabled under `prefers-reduced-motion`.
  - Verified in a real browser at 375: drawer fully off-screen when closed (x=-300), slides to x=0 on tap, backdrop click closes it, body locks and unlocks, and navigating resets it. Desktop at 1280 is pixel-identical — rail sticky at x=0 240px wide, no transform, all three controls `display:none`, main at x=240.
  - Full suite 1149 passing. (An intermediate run showed 9 failures; they were `beforeEach` TIMEOUTS caused by my own headless browsers starving the test runner, not the change — clean once they were shut down.)
- [x] Refactor scheduling so Vercel owns only the once-daily morning task delivery: drop the hourly dispatcher, retire Tasks-app EOS scheduling to Hermes, exclude the five Hermes-managed Daily Anchors from the Personal post, isolate Agency and Personal failures — see docs/specs/daily-only-scheduling.md
  - Done 2026-09-11: `0 * * * *` replaced by `0 13 * * *` — one entry, once a day. `runDueJobs` is gone and with it the entire clock: no `dueJobs`, no grace window, no calendar arithmetic. The hourly loop only ever existed because the EOS reminders needed several times of day; Hermes owns those now, so the question it was asking disappeared.
  - **13:00 UTC = 08:00 Chicago under CDT (~8 months) and 07:00 under CST (~4 months).** Exact 8:00 year-round is NOT achievable cleanly on Hobby — a UTC-only cron cannot track a moving zone, and the alternatives are two entries toggled by hand twice a year or the hourly poll this refactor removed. Documented as a limitation rather than worked around, per the brief. Anything needing exact local timing goes to Hermes.
  - Daily Anchors (Meditate, Exercise, Journal, Cold Exposure, Vocal Warm-Ups) excluded from the Personal post, matched on the WHOLE title case-insensitively — never as a substring, so "Meditate with Rachael before the Level 10" still appears. That whole-title rule is the interesting part: a substring match would have silently eaten real one-off tasks. Verified against live data: 10 open Personal tasks in the DB, 5 in the post, look-alike kept, probes cleaned up.
  - It is a DELIVERY rule, not a query change — `/tasks personal`, the web UI, REST and MCP all still show all five. `listOpenTasksBySpace` remains the single retrieval path; the filter is applied to its result.
  - Agency and Personal are isolated: separate ledger claims, separate try/catch, Agency awaited before Personal starts. Agency failure still attempts Personal; Personal failure leaves Agency's delivery recorded as posted. A failure releases only its own claim, so the next run retries just that one. New `sanitizeError` masks `xox*` tokens and `Bearer` headers and truncates, so nothing credential-shaped reaches a log.
  - Removed: `postEOSReminder`, `eosReminderMessage`, `EOSReminderType`, the EOS calendar helpers, `schedule.test.ts`, and the now-dead `EOS_APP_URL` / `eosAppUrl` config. They were used nowhere else — the brief allowed keeping them only if they were. The exact EOS wording is preserved in SCHEDULED.md so the handover to Hermes does not lose it.
  - Two determinism guards initially failed on my own COMMENTS (prose explaining what moved to Hermes tripped the /hermes/i and /eos/i scans). Fixed by stripping comments before the grep, the same way `no-secrets.test.ts` already does — the codebase documents this exact trap.
  - New `cron.test.ts` guards the deployed schedule itself: exactly one entry, never `0 * * * *`, and neither the minute nor hour field may hold a wildcard/list/range/step — so "just make it hourly" cannot pass review by accident. It also asserts the 08:00 CDT / 07:00 CST outcome, so the numbers in the docs cannot quietly go stale.
  - Manual testing goes through the production handler, no fake scheduling path: `pnpm scheduled dispatch [--dry-run]`, `pnpm scheduled run <job>`, `pnpm scheduled preview <job>`, or `curl` the endpoint with `CRON_SECRET`. Verified the rehearsal leaves the ledger empty and the retired `eos-*` jobs are rejected by both the CLI and the endpoint (400).
  - Full suite 1135 passing across 65 files; `pnpm web:build` clean.

## Reference

Pasted into TASKS.md from another session's terminal while this one was
offline. It is background for the production task above, not a task itself.
The D1 brief below was answered **A** in that transcript.

### Productiontask
```
No—an HTTP deployment does not need a keep-alive bot.

The flow becomes:

Slack command → Vercel function starts → verifies request → immediately acknowledges →
creates task → function ends

There is no persistent socket to maintain. Vercel may scale the function to zero, but it
invokes it again when Slack sends a request. Artificial pings don’t guarantee the same
instance remains warm and only waste invocations. Vercel Functions lifecycle

We should instead ensure:

- ack() happens before database or Slack API work; Slack allows three seconds. Slack
  acknowledgment guidance

- Database migrations run during deployment, never during a Slack request.
- Fluid Compute is enabled to reduce cold starts.
- The function runs near the Supabase region.
- We record acknowledgment latency and errors.

If cold starts cause measured failures on Vercel Hobby, the reliable remedies are a paid
pre-warmed function or an always-on host—not a ping bot. Vercel’s paid production
environments support pre-warmed instances. Vercel compute documentation

──────────────────────────────────────────────────────────────────────────────────────────────
› ok proceed to set it up

• I’ll wire the Slack app into the existing Vercel deployment as an HTTP endpoint, preserve
the current local Socket Mode workflow, update the Slack manifest/setup instructions, and
verify the serverless request path. I’m using the deployment-setup workflow plus current
Vercel and Bolt documentation because this changes runtime and request-handling behavior.

──────────────────────────────────────────────────────────────────────────────────────────────
### D1 — Authorize the production dashboard changes

  Project/branch/task: Deploy the current master workspace to Vercel and switch the Slack app
  from local Socket Mode to the verified HTTP endpoint.

  ELI10: Aside is connected, but Vercel and Slack are real accounts. I need explicit approval
  before creating a project, deploying code, or changing Slack’s delivery settings. You will
  handle any sign-in, CAPTCHA, or secret-entry screen yourself.

  Stakes if we pick wrong: Slack commands could temporarily stop working if Socket Mode is
  disabled before the live endpoint passes its health check.

  Recommendation: A, because it completes the production cutover while preserving the local
  bot until verification succeeds.

  A) Complete the Vercel and Slack setup (recommended). Completeness: 10/10. I’ll create or
  link the Vercel project, set apps/web as its root, guide you through protected environment-
  variable entry, trigger the production deployment, and verify its health. Only after it
  passes will I update /task, /tasks, /space, /import, and Interactivity in Slack, then
  disable Socket Mode.

  B) Configure Vercel only. Completeness: 7/10. I’ll create, configure, deploy, and verify the
  Vercel project, while leaving every Slack setting unchanged. This preserves the current
  connection but does not solve mobile task creation until the later Slack cutover.

  C) Read-only inspection. Completeness: 3/10. I’ll inspect the Vercel and Slack dashboards
  and report their current state without submitting changes. This carries the least account
  risk but leaves deployment and the socket-disconnection problem unresolved.

  Net: A completes the fix; B stages it safely; C only diagnoses.

  Reply with A, B, or C.
