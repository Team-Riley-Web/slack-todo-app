-- The ledger behind deterministic scheduled delivery.
--
-- Vercel Cron fires this app hourly and the handler decides, from the current
-- America/Chicago wall clock, which jobs are due. That is resilient to DST and
-- to a missed tick, but on its own it would post the 8am digest again at 9am
-- and again on every retry of a failed invocation.
--
-- One row per (job, local date) claims an occurrence. The primary key is the
-- lock: a second invocation's INSERT ... ON CONFLICT DO NOTHING returns no row
-- and that invocation does nothing. The claim is released again if the Slack
-- post fails, so the next hourly tick retries inside the grace window.
--
-- `occurrence` is a DATE in the schedule's own zone, not a timestamp. The
-- question this table answers is "has the Friday 11am Level 10 for 2026-09-11
-- gone out", and a date is exactly that question -- a timestamptz would make
-- two ticks an hour apart look like two different occurrences.
CREATE TABLE scheduled_runs (
  job_key    text        NOT NULL,
  occurrence date        NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  -- 'claimed' while in flight, then 'posted' or 'skipped'. A row stuck on
  -- 'claimed' means an invocation died mid-post; it is visible rather than
  -- silently retried, because a retry could double-post.
  outcome    text        NOT NULL DEFAULT 'claimed',
  -- What went out: channel, message timestamps, task count. Diagnostics only.
  detail     jsonb,
  PRIMARY KEY (job_key, occurrence)
);

CREATE INDEX scheduled_runs_claimed_at_idx ON scheduled_runs (claimed_at DESC);

-- Migration 009 was a one-time pass over the tables that existed then, so a
-- table created afterwards must lock itself down. `api-lockdown.test.ts`
-- asserts exactly this for every migration after 009.
ALTER TABLE scheduled_runs ENABLE ROW LEVEL SECURITY;
