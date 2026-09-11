-- Priority, requested 2026-09-11.
--
-- Nullable with no default, so every task that already exists becomes
-- Unprioritized without a rewrite and without a backfill. A DEFAULT 'P2' would
-- have been a claim about 600-odd historical tasks that nobody actually made.
--
-- Stored as the label rather than an integer rank on purpose. 'P0'..'P3' sort
-- lexically in exactly the order they rank, so `ORDER BY priority NULLS LAST`
-- IS the required ordering -- no CASE expression, no lookup table, and no way
-- for the display name and the sort key to drift apart. The cost is four bytes
-- a row over a smallint, which is not a cost.
--
-- The CHECK is the outer guard. Every write also validates in task-core, but a
-- constraint is the one check that cannot be bypassed by a new code path.
ALTER TABLE tasks ADD COLUMN priority text
  CHECK (priority IN ('P0','P1','P2','P3'));

-- Open work sorted by priority is the query every list runs. NULLS LAST here
-- matches the ORDER BY, so the index can serve the sort rather than being
-- read and then re-sorted.
CREATE INDEX tasks_status_priority_idx
  ON tasks (status, priority NULLS LAST);
