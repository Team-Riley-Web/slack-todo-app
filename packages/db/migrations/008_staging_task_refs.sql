-- Rollback hard-deletes the tasks an import created, but import_staging points
-- at them, so those foreign keys would block the delete. Found by a test that
-- tried to make an imported task vanish.
--
-- ON DELETE SET NULL is right rather than CASCADE: the staging row is the
-- record of what was submitted and must outlive the task it produced. Only the
-- pointer goes.
ALTER TABLE import_staging
  DROP CONSTRAINT import_staging_canonical_task_id_fkey,
  ADD CONSTRAINT import_staging_canonical_task_id_fkey
    FOREIGN KEY (canonical_task_id) REFERENCES tasks(id) ON DELETE SET NULL;

ALTER TABLE import_staging
  DROP CONSTRAINT import_staging_duplicate_task_id_fkey,
  ADD CONSTRAINT import_staging_duplicate_task_id_fkey
    FOREIGN KEY (duplicate_task_id) REFERENCES tasks(id) ON DELETE SET NULL;
