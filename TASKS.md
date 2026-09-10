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
