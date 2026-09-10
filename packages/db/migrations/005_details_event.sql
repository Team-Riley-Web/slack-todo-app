-- `details` is now updatable (title still is not), so the audit log needs an
-- event kind for it. The CHECK constraint has to be replaced, not extended.
ALTER TABLE task_events DROP CONSTRAINT task_events_event_check;
ALTER TABLE task_events ADD CONSTRAINT task_events_event_check
  CHECK (event IN ('created','completed','reopened','moved','details'));
