-- A checkbox payload carries the group's whole selection, not which box moved,
-- so it must be diffed against the render the clicking client actually saw.
-- Diffing against the LATEST render made a second user's stale payload look
-- like a deliberate uncheck, silently reopening the first user's completed task.
--
-- The render version is carried in each block_id, and the last few rendered
-- states are retained so a payload can be matched to its own baseline.
ALTER TABLE slack_cards ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE slack_cards ADD COLUMN rendered_versions jsonb NOT NULL DEFAULT '{}'::jsonb;
