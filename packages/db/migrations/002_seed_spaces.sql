INSERT INTO spaces (name, slug, is_inbox) VALUES
  ('Inbox',                       'inbox',                  true),
  ('Agency / Internal',           'agency-internal',        false),
  ('Marketing',                   'marketing',              false),
  ('Sales',                       'sales',                  false),
  ('Personal',                    'personal',               false),
  ('Client - Joy Within Birth',   'joy-within-birth',       false),
  ('Client - Secure Logic',       'secure-logic',           false),
  ('Client - CFC Skincare',       'cfc-skincare',           false),
  ('Client - Nazareth Law',       'nazareth-law',           false),
  ('Client - Milltown Cabinets',  'milltown-cabinets',      false),
  ('Client - Yoga Farm',          'yoga-farm',              false)
ON CONFLICT (name) DO NOTHING;

INSERT INTO lists (space_id, name)
SELECT s.id, l.name FROM spaces s
  CROSS JOIN (VALUES ('Open'), ('Waiting / Blocked')) AS l(name)
ON CONFLICT (space_id, name) DO NOTHING;
