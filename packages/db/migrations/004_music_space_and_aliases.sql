-- Approved 2026-09-09, resolving two mismatches between the brief's Space list
-- and the live Workast export.

-- Decision 1: Music is its own top-level Space, matching how it is actually used
-- (2 open tasks as a peer of Marketing), not a Personal sub-domain.
INSERT INTO spaces (name, slug, is_inbox) VALUES ('Music', 'music', false)
ON CONFLICT (name) DO NOTHING;

INSERT INTO lists (space_id, name)
SELECT s.id, l.name FROM spaces s
  CROSS JOIN (VALUES ('Open'), ('Waiting / Blocked')) AS l(name)
ON CONFLICT (space_id, name) DO NOTHING;

-- Decision 2: deterministic Space aliases. Configuration data, same as Space
-- names themselves — an enumerated exact-match table, never fuzzy matching.
-- `Personal tasks` (Workast) resolves to the `Personal` Space.
CREATE TABLE space_aliases (
  alias      text PRIMARY KEY,
  space_id   uuid NOT NULL REFERENCES spaces(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO space_aliases (alias, space_id)
SELECT 'personal tasks', id FROM spaces WHERE name = 'Personal'
ON CONFLICT (alias) DO NOTHING;
