-- Editing a task is a distinct audit event from the deterministic transitions.
ALTER TABLE task_events DROP CONSTRAINT task_events_event_check;
ALTER TABLE task_events ADD CONSTRAINT task_events_event_check
  CHECK (event IN ('created','completed','reopened','moved','details','edited'));

-- Idempotency key for imports, and the batch tag rollback needs.
ALTER TABLE tasks ADD COLUMN source_external_id text;
ALTER TABLE tasks ADD COLUMN import_batch_id uuid;

-- The strongest idempotency guarantee available: a given source record can
-- exist at most once per platform. Partial, so ordinary Slack tasks are exempt
-- and may freely share titles.
CREATE UNIQUE INDEX tasks_source_external_id_key
  ON tasks (source_platform, source_external_id)
  WHERE source_external_id IS NOT NULL;
CREATE INDEX tasks_import_batch_idx ON tasks (import_batch_id)
  WHERE import_batch_id IS NOT NULL;

CREATE TABLE import_batches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type    text NOT NULL CHECK (source_type IN ('csv','json','workast','kanban')),
  filename       text,
  state          text NOT NULL DEFAULT 'PARSED'
                 CHECK (state IN ('PARSED','MAPPED','ANALYZED','CONFIRMED','IMPORTED','ROLLED_BACK','ABORTED')),
  mapping        jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_count      integer NOT NULL DEFAULT 0,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  confirmed_by   text,
  confirmed_at   timestamptz,
  imported_at    timestamptz,
  rolled_back_at timestamptz,
  CONSTRAINT confirmed_fields_together CHECK (
    (confirmed_at IS NULL AND confirmed_by IS NULL) OR
    (confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)
  )
);

CREATE TABLE import_staging (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number            integer NOT NULL,
  source_type           text NOT NULL,
  source_record_id      text,
  -- Source bytes. Never rewritten by mapping or by import.
  title                 text NOT NULL,
  space                 text,
  list_state            text,
  assignee              text,
  due_at                text,
  waiting_on            text,
  created_at            text,
  completed_at          text,
  status                text,
  source_metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Filled by the mapping step.
  resolved_space_id     uuid REFERENCES spaces(id),
  resolved_assignee_id  text,
  resolved_status       text CHECK (resolved_status IN ('open','waiting','completed')),
  resolved_due_at       timestamptz,
  resolved_created_at   timestamptz,
  resolved_completed_at timestamptz,
  idempotency_key       text,
  -- Filled by the analyze step.
  verdict               text CHECK (verdict IN ('READY','SKIP_DUPLICATE','NEEDS_REVIEW','INVALID')),
  reason                text,
  duplicate_task_id     uuid REFERENCES tasks(id),
  canonical_task_id     uuid REFERENCES tasks(id),
  UNIQUE (batch_id, row_number)
);
CREATE INDEX import_staging_batch_verdict_idx ON import_staging (batch_id, verdict);

-- canonical_task_id deliberately has NO foreign key: rollback hard-deletes
-- tasks, and the audit row must survive to record that it happened.
CREATE TABLE import_audit (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  source_type       text NOT NULL,
  source_record_id  text,
  canonical_task_id uuid,
  action            text NOT NULL
                    CHECK (action IN ('IMPORTED','SKIPPED_DUPLICATE','NEEDS_REVIEW','FAILED','ROLLED_BACK')),
  reason            text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_audit_batch_idx ON import_audit (batch_id, action);
CREATE INDEX import_audit_source_idx ON import_audit (source_type, source_record_id, action);
