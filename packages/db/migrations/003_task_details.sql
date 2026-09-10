-- Approved 2026-09-09. The Workast export carries per-task `details` up to
-- 3,224 characters (workstream, next actor, scope, explicit boundaries). Without
-- this column that content is lost on import.
--
-- Write-at-create and read-only thereafter in Phase 1: there is no update path,
-- deliberately, so this stays a record of what was captured rather than a
-- mutable notes field.
ALTER TABLE tasks ADD COLUMN details text;
