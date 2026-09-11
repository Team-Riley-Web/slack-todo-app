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
  