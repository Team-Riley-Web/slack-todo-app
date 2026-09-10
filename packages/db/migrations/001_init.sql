CREATE TABLE spaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  slug       text NOT NULL UNIQUE,
  is_inbox   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lists (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id   uuid NOT NULL REFERENCES spaces(id),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (space_id, name)
);

CREATE TABLE channel_space_map (
  slack_channel_id   text PRIMARY KEY,
  slack_channel_name text,
  space_id           uuid NOT NULL REFERENCES spaces(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title             text NOT NULL,
  space_id          uuid NOT NULL REFERENCES spaces(id),
  list_id           uuid REFERENCES lists(id),
  assignee_id       text,
  status            text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','waiting','completed')),
  due_at            timestamptz,
  waiting_on        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  source_platform   text NOT NULL DEFAULT 'slack',
  source_channel_id text,
  source_message_ts text,
  created_by        text,
  CONSTRAINT completed_at_iff_completed CHECK (
    (status = 'completed' AND completed_at IS NOT NULL) OR
    (status <> 'completed' AND completed_at IS NULL)
  )
);
CREATE INDEX tasks_space_status_idx ON tasks (space_id, status);
CREATE INDEX tasks_status_idx       ON tasks (status);

CREATE TABLE task_events (
  id         bigserial PRIMARY KEY,
  task_id    uuid NOT NULL REFERENCES tasks(id),
  event      text NOT NULL CHECK (event IN ('created','completed','reopened','moved')),
  actor_id   text,
  source     text NOT NULL,
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_events_task_idx ON task_events (task_id, created_at);

CREATE TABLE slack_cards (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id     text NOT NULL,
  message_ts     text NOT NULL,
  task_ids       uuid[] NOT NULL,
  rendered_state jsonb NOT NULL,
  view_scope     text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, message_ts)
);

CREATE TABLE processed_interactions (
  channel_id   text NOT NULL,
  message_ts   text NOT NULL,
  action_ts    text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, message_ts, action_ts)
);
