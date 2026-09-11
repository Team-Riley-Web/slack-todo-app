# Priority system — spec as given, 2026-09-11

Captured verbatim from the request so the six `TASKS.md` entries stay short
without losing the detail. Nothing here is inferred.

## End goal

* Tasks can be assigned a priority when created in Slack.
* Tasks can be assigned/edited from the Web UI.
* Priority is visually obvious in the Web UI using colored pills.
* Higher-priority tasks automatically appear first everywhere tasks are listed.
* Existing tasks without a priority continue working normally.

## Priority levels

* `P0` — Critical
* `P1` — High
* `P2` — Medium
* `P3` — Low

Tasks without a priority are **Unprioritized** and sort below P3.

Sorting order: `P0 → P1 → P2 → P3 → Unprioritized`

Within the same priority level, preserve the existing task sort behavior unless
there is a strong architectural reason not to.

## 1. Slack task creation

Allow priority to be entered naturally: `/task P0 Fix production checkout issue`,
or whatever the equivalent task-capture syntax already is. The parser recognises
`P0`, `P1`, `P2`, `P3` when included in the task text.

* Priority tokens are case-insensitive — `p0`, `P0` both work.
* Remove the priority token from the actual task title.
* Save the priority as structured task data, not as text in the task name.
* Do not interpret `P01` or unrelated text as a priority.
* Existing task creation syntax must keep working when no priority is given.

Input `P0 Fix Stripe checkout` stores `title: Fix Stripe checkout`, `priority: P0`.

## 2. Slack task display

Show priority when rendering tasks. Keep the current compact checkbox UX.

```text
☐ [P0] Fix Stripe checkout
☐ [P1] Finish client homepage
☐ Update footer links
```

No excessive visual clutter. All task lists sort by priority first — everywhere
the app displays open tasks, including `tasks all` and the scheduled daily posts.

## 3. Web UI — creation and editing

A **Priority** field on the task model and in the UI, selectable as:
P0 Critical, P1 High, P2 Medium, P3 Low, No priority.

A dropdown/select or another compact control consistent with the existing design
system. Editable after a task has been created.

## 4. Priority column

A **Priority** column anywhere tasks are shown in a table/grid-style Web UI,
displayed as compact colored pills/badges with distinct treatments for P0–P3:

* P0 = strongest / critical treatment
* P1 = high attention
* P2 = moderate attention
* P3 = low attention

Do not hard-code arbitrary colors if a design-token or theme system exists —
integrate with the existing visual system. Unprioritized shows either `—` or a
subtle neutral `None` pill, whichever fits the current UI better.

## 5. Sorting

Priority sorting happens at the shared task-query/domain level wherever possible,
not reimplemented per UI. Order: `P0, P1, P2, P3, null`.

Affects: Slack task lists, `tasks all`, Agency Ops daily posts, Personal daily
posts, Web UI task lists, and any other open-task view using the shared task
retrieval logic.

An explicit user sort on a Web UI column may override the default for that view.
The default remains highest priority first.

## 6. Data model / migration

An enum/validated string: `P0`, `P1`, `P2`, `P3`, `null`. Existing tasks migrate
safely to `priority: null`; do not break existing records. All task creation and
update paths validate the allowed values.

## 7. MCP / API compatibility

Include priority in the task representation where tasks are exposed:

```json
{ "id": "...", "title": "Fix Stripe checkout", "priority": "P0", "completed": false }
```

Existing consumers that do not send a priority keep working. If MCP has
`create_task` / `update_task`, priority may be supplied there too.

## 8. Reuse existing architecture

No parallel task system. Extend the existing task model, Slack task parser, task
creation flow, task renderer, `tasks all` query, Web UI components, and API/MCP
task functions. Priority becomes a first-class task property throughout.

## 9. Tests required

1. `P0 Fix issue` creates a P0 task named `Fix issue`.
2. Lowercase `p1` works.
3. A task with no priority remains valid.
4. Invalid values such as `P7` are not accepted as priority.
5. Priority can be changed in the Web UI/API.
6. Existing tasks without priority still load.
7. P0 sorts before P1.
8. P3 sorts before unprioritized.
9. `tasks all` returns tasks in priority order.
10. Scheduled Agency and Personal task posts inherit the same priority ordering.

## Report back with

1. Files changed
2. Data/schema changes
3. Slack parsing changes
4. Web UI changes
5. Priority pill implementation
6. Shared sorting logic
7. MCP/API changes
8. Migration behavior for existing tasks
9. Tests added
10. A few example Slack commands to verify it manually
