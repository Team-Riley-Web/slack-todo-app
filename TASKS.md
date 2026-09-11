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
- [x] Create task pane should show all the same fields as Edit task - needs Waiting on and Details options available. the New task pane is missing three fields Edit has — Status, Waiting on, Details. All three should match Edit's own field order, so the two forms read the same way top to bottom.
  - Done 2026-09-11 (first pass), re-verified after you reported not seeing it. The code IS correct and IS pushed — `NewTaskPane.tsx` in commit `fbdbb60` carries `name="status"`, `name="waitingOn"` and `name="details"`, and a live render of both panes returns an identical field order: title, space, status, priority, assignee, due, waiting on, details. The only difference is `spaceSlug` vs `spaceId`, which is inherent to create vs edit.
  - **You are not seeing it because production is still serving the OLD build, not because the change is missing.** Production returns stylesheet `153fc568e06abd00.css`, which lacks every marker from this push; a build of the pushed commit produces `c26dc1d458a9817c.css`, which has them all. `/mcp/health` returns 404 rather than 503, so those routes do not exist in the live build either — same cause.
  - Status offers Open and Waiting / blocked, not Completed, matching the Slack capture modal: a task that is already done is an edit, not a capture. `createTaskOp` rejects `completed` outright so a hand-built POST cannot bypass the missing option.
  - Blocked on deployment only — see the production-launch notes. Nothing further to change in the code.
- [x] All spaces view: group tasks by Space the way the Slack card does, instead of one flat Open list with a Space column — each Space its own section, with Open and Waiting inside it rather than Open/Waiting at the top level
  - Done 2026-09-11: All spaces now renders one card per Space, in `listSpaces` order — the same order the rail and the Slack digests use. 11 cards, counts matching the rail exactly. The Space column is gone from the rows: the card names it once, so reading the same Space down thirty rows is no longer how you work out what belongs together. A single-Space view is unchanged — it still shows Open and Waiting, because the page already names the Space.
  - You floated two shapes and I built the second (Space cards containing Open and Waiting). It degrades into the first on its own: most Spaces have no blocked work, so most cards are simply a list of tasks with no subheading at all. Only 3 of 11 cards show a WAITING group.
  - Waiting rows keep the SAME columns as the open rows above them. The card has one column header and a second set of columns under it would not align. What a task waits on is still on /waiting and in the edit pane.
  - Two details worth knowing: a Space with nothing in it is omitted rather than shown empty, and a Space holding only blocked work renders just the WAITING group — both halves are conditional, so no empty-state line ever appears under a card that plainly has tasks in it. Zebra striping restarts per list, so the CSS re-flips `nth-child` after a subheading.
  - Note: the column header now repeats on every card. Kept deliberately — it is what makes each card self-describing and keeps the sort links reachable. Say the word if you would rather it appear once at the top.
- [x] Hide the Wait button on mobile
  - Done 2026-09-11: the Wait / Unblock cell is hidden below 860px, alongside assignee, due, age and priority. The cell leaves the grid template with it — this row is a positional grid, so a hidden cell that stays in the template shifts every column after it.
  - It was the widest thing competing with the title, which was wrapping to three lines on a phone. Titles now fit in one or two. The tick still completes a task and status is still changeable from the edit pane, so nothing is unreachable.
- [x] Make the Search tasks box smaller
  - Done 2026-09-11: 210px to 150px. The placeholder still fits. It is a filter, not the subject of the page.
- [x] Drop the "Assignee" label — the control alone is enough on both mobile and desktop
  - Done 2026-09-11: removed. The button already reads "Anyone" or a person's name, so the word beside it was labelling a control that labels itself. The accessible name stays on the checkbox, so screen readers still hear what it filters.
- [x] On desktop, right-align the assignee control while keeping the filter pills left-aligned
  - Done 2026-09-11: the existing `.filter-spacer` between the pills and the control now grows (`flex: 1 1 0`), pushing the control to the right edge while the pills stay left. A flexible spacer rather than `margin-left: auto` on the control, so the rule holds wherever the control sits in the row.
  - It collapses to zero below 860px. A spacer that kept growing on a phone would strand the control alone on its own line; instead it now sits beside the pills.
- [x] Remove the "No date" filter pill — unused
  - Done 2026-09-11: the pill is gone. The `none` bucket itself stays in `parseFilters` and `listTasks`, so an existing `?due=none` URL still works and the REST/MCP filter is unchanged — only the pill was removed.
- [x] All spaces: give the WAITING subhead the same grey background the Task column header has, so the two read as the same kind of divider
  - Done 2026-09-11: `--header-bg`, the same token the column header uses, plus a matching 34px min-height and 16px side padding. It was a bare top border, which read as a different mechanism from the header sitting a few rows above it. Matching the height mattered as much as the colour — a divider a few pixels taller than the band it echoes reads as a mistake rather than a match.
- [x] Move Search tasks and New task down into the filter row, where the assignee control sits — one toolbar row instead of two. Exact arrangement is open; propose something.
  - Done 2026-09-11: one row. Pills left; Assignee, Search, then New task right. The title now sits alone on the line above, and the list starts higher.
  - The arrangement you left open: reading order left to right is everything that NARROWS the list (due pills, assignee, search), and last the one thing that ADDS to it. Pills stay left because they are the control reached for most; the action sits furthest from them so it is never hit by accident.
  - `.toolbar` is the flex container now and `.filters` grows inside it, so FilterBar's existing trailing spacer pushes the assignee control to the boundary between the two halves rather than to the far edge of the screen.
- [x] Assignee control should read "Assignee" instead of "Anyone"
  - Done 2026-09-11: the empty state reads "Assignee". With the label removed earlier, the word has to name the control as well as its value. A chosen person still shows their own name, which is the state worth seeing.
- [x] Auto-capitalize the first letter of every task title — verify it applies to tasks captured from Slack, not just the web UI
  - Done 2026-09-11. **The code was never broken — the Slack process was stale.** `pnpm slack` runs Socket Mode in a long-lived local process, and that process had been up since Sep 10 18:15, sixteen hours before `capitalize.ts` was written at 10:11 today. Slack events go to that process, not to Vercel, so every task captured from Slack ran yesterday's code. All 11 lowercase titles were `source_platform = slack`, timestamped 14:14–16:15 today, well after the deploy. Restarting it fixes future captures.
  - Worth remembering: a Vercel deploy does NOT update the Slack app while Socket Mode is on. The local process has to be restarted, or the Slack app has to be cut over to the HTTP receiver at /api/slack/events.
  - Backfilled the 11 existing titles through `editTask` — the single audited title write path — so each change is logged as an edited event and is reversible from history. Previewed the full diff first: 11 changed, 0 declined, one character each. 0 lowercase-opening open/waiting tasks remain.
- [x] Mobile: move the hamburger to the top right-hand corner
  - Done 2026-09-11: fixed at top right, 40px inset 8px. The drawer now opens from the RIGHT too — a drawer flying in from the opposite edge to its own control reads as a different thing.
- [x] Mobile: closing the drawer automatically when a Space or Client is selected
  - Done 2026-09-11. **This was a real bug and my earlier reasoning about it was wrong.** The comment said "every page is a fresh server render, so the checkbox starts unchecked". Under the App Router that is false: a Link navigates on the CLIENT, the DOM is kept, React reconciles the same input element, and a checked box stays checked — so the drawer sat open over the page you had just opened. Fixed with a `key` tied to the route, which forces a fresh element; a fresh checkbox is unchecked. Still no JavaScript of ours, and client-side navigation is preserved (plain `<a>` links would also have worked, at the cost of a full reload every time).
  - The assignee dropdown had the identical bug, with a comment making the identical false claim — it stayed open over the list it had just filtered. Fixed the same way and corrected the comment. Not queued, but it is the same defect in the same mechanism and you would have hit it next.
  - Verified by driving a real browser: open drawer, tap Marketing, drawer reports closed and slides off-screen; open assignee menu, choose a name, menu reports closed.
- [x] Mobile: show an X button in the drawer when it is open, in the right-hand corner
  - Done 2026-09-11: one control in two states rather than two controls. Both glyphs render and CSS shows whichever matches the checkbox, so the button that opens the drawer is the button that closes it — same position, same focus ring, same accessible name across the change. New `close` icon on the same 24 grid and stroke as the rest of the set.
- [x] Mobile: make it a proper sticky top navigation — the section name and the hamburger on the same level across from each other, instead of the name sitting below the hamburger
  - Done 2026-09-11: `.page-head` is a 56px sticky bar with the section name left and the button right, optically centred on the same line, with a border under it.
  - What was actually putting the name below the button: `.main` still carried a 52px top padding added earlier to push content clear of a floating hamburger. With the bar now reserving the button's lane via its own right padding, that padding was the bug. Removed.
- [x] Mobile: the search box is too wide and looks funky
  - Done 2026-09-11: search and New task now share one wrapped line under the pills — search flexes to fill, the button keeps its width. It was sized for a desktop toolbar, so at 390px it ran the full width and pushed New task onto a third row of its own.
- [x] Mobile: put the assignee control on the right, opposite the filter pills
  - Done 2026-09-11: the `.filter-spacer` now grows at every width instead of collapsing below 860px, so the control sits at the right edge opposite the due pills on a phone as well as a desktop.
- [x] OPEN and WAITING group bands on task cards, tinted blue and purple — all spaces and interior spaces
  - Done 2026-09-11: the band above each group now names the GROUP, not its first column — OPEN or WAITING, uppercase with the letter spacing the old Waiting subheading had. The remaining cells stay the sortable column labels they always were, so one strip does both jobs. A card used to stack a "Task / Priority / Assignee / Due date" header directly on top of a "WAITING" band: two grey bars meaning different things.
  - Tints: blue `oklch(0.965 0.018 266)` for open, purple `oklch(0.965 0.018 305)` for blocked. Both leave the label at ~13.6:1, so the colour decorates a word that is already there rather than carrying meaning on its own. Applied on interior Space pages as well as All spaces.
  - Caught while looking at it: Milltown Cabinets has only blocked work, and the card was rendering an empty OPEN band above the WAITING one — labelling rows that were not there. Each group emits its own band now (`columns="none"` on the card), so a Space with only waiting work shows only WAITING.
  - The `.subhead` element and the zebra-restart overrides it needed are both gone: every list sits under its own band now, so they all start counting from the same place and the default striping is correct for all of them.
  - Full suite 1143 passing.
- [x] Tint the Open/Waiting card summaries instead of repeating an OPEN band on Space pages; waiting bg oklch(0.56 0.26 279.32 / 0.09), letter-spacing 0
  - Done 2026-09-11: on a Space page the summary already says Open or Waiting, so the band beneath it was saying the same thing twice. The tone moved onto the summary row and the band is gone there — one element instead of two, matching the mockup.
  - All spaces keeps its bands, because there the card title is the Space name and the band is the only thing naming the group. So the rule is: whichever element names the group carries the tone.
  - Waiting uses the exact value given, `oklch(0.56 0.26 279.32 / 0.09)`. Open takes the same recipe on the app's own accent hue, `oklch(0.56 0.26 266 / 0.09)`, so the pair reads as a family rather than two unrelated choices. Both are a saturated colour at 9% alpha rather than a pre-mixed light value, which means one declaration sits correctly on the card and on a zebra stripe without a second variant for each. Letter-spacing on the band label set to 0.
  - Full suite 1143 passing.
- [x] Give each card title row the original grey background, for more visual distinction between cards
  - Done 2026-09-11: `--header-bg` on the card summary, the same grey the column band uses. On All spaces the title row was white on a white card, so eleven cards ran together as one long sheet and the Space name was the only thing separating them. Each card now has a top edge you can see.
  - Rounded to match the card's own corners — an unrounded fill would square off the top of a rounded box — and a collapsed card rounds on all four, since then the title row IS the whole card.
  - Space pages are unaffected: the Open/Waiting tones are more specific, so those summaries keep their own colour. Verified by reading computed styles back from the browser, not by eye.
  - Full suite 1143 passing.
