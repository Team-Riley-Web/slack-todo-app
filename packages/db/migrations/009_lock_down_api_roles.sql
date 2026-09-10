-- Supabase auto-exposes every table in `public` through PostgREST, reachable
-- with the anon key. That key is public by design -- it ships in browser
-- bundles. With RLS off, holding it would mean reading every task.
--
-- Nothing in this system uses PostgREST. Every client (the Slack app, the REST
-- API, the MCP server, the web app) connects as the database owner over the
-- Postgres protocol. So the correct posture is: the API roles get nothing.
--
-- Two independent layers, because either alone has a gap:
--   1. REVOKE  -- removes the grant PostgREST needs. Also set as the default
--               for tables created later, so a future migration cannot
--               silently re-expose the schema by forgetting this file.
--   2. RLS     -- enabled with zero policies, which denies every row. Table
--               owners bypass RLS, so our own connections are unaffected.
--
-- The `anon` and `authenticated` roles exist only in a Supabase database, so
-- the revokes are guarded. PGlite and a plain Postgres run the RLS half and
-- skip the rest.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON SCHEMA public FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON SEQUENCES FROM anon, authenticated;
  END IF;
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
