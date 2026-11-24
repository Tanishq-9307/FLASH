-- M6-1: search quota (TASKS.md M6-1, DATABASE.md §3.2, §5.1).
--
-- Plain language: this migration creates the table and functions the
-- web-search cap needs, mirroring the model-call cap (M1-3/M1-4).
-- `search_usage` counts web searches per user per day (Asia/Kolkata
-- day); its composite primary key (user_id, usage_date) is what makes
-- the daily cap a single atomic upsert instead of a read-then-write.
-- `reserve_search` reserves one search for today in a single atomic
-- upsert: the INSERT itself runs only when the cap is at least 1, so
-- a cap of 0 returns no row and writes nothing (the M3-27
-- fail-closed fix, built in from the start — the model-call cap
-- needed it as a fix because its original INSERT was unconditional);
-- if the user already has a row for today and is under the cap it
-- increments and returns the new count; if the cap is reached it
-- returns no row, so the server knows to refuse without calling the
-- provider. Two requests arriving at the same instant cannot both
-- pass the cap, because the cap check and the increment are one
-- statement. `refund_search` undoes one reservation on the original
-- day, clamped at zero, and is used only when the server aborts
-- before dispatching to the provider (never for provider errors).
-- The day boundary is Asia/Kolkata midnight. RLS is on, SELECT-only
-- for clients; only the service-role functions write it. Safe to run
-- twice: IF NOT EXISTS, CREATE OR REPLACE, idempotent REVOKE/GRANT.

-- search_usage (DATABASE.md §3.2): daily web-search counts, SELECT-only.
CREATE TABLE IF NOT EXISTS public.search_usage (
  user_id uuid NOT NULL DEFAULT auth.uid()
    REFERENCES auth.users (id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  searches int NOT NULL DEFAULT 0 CHECK (searches >= 0),
  PRIMARY KEY (user_id, usage_date)
);

ALTER TABLE public.search_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "search_usage_owner_select" ON public.search_usage;
CREATE POLICY "search_usage_owner_select" ON public.search_usage
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Explicit grants (DATABASE.md §4): revoke the broad Supabase defaults,
-- then grant exactly what the table needs. Writes to search_usage go only
-- through the service-role functions below.
REVOKE ALL ON public.search_usage FROM anon, authenticated;
GRANT SELECT ON public.search_usage TO authenticated;

-- Reserve one web search for today; no row returned when the cap is hit.
CREATE OR REPLACE FUNCTION public.reserve_search(p_user_id uuid, p_cap int)
RETURNS TABLE (searches int, usage_date date)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO search_usage (user_id, usage_date, searches)
  SELECT p_user_id, (now() AT TIME ZONE 'Asia/Kolkata')::date, 1
  WHERE p_cap >= 1
  ON CONFLICT (user_id, usage_date)
  DO UPDATE SET searches = search_usage.searches + 1
  WHERE search_usage.searches < p_cap
  RETURNING search_usage.searches, search_usage.usage_date;
$$;

-- Refund one reservation on the original day; never below zero.
CREATE OR REPLACE FUNCTION public.refund_search(p_user_id uuid, p_usage_date date)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE search_usage
  SET searches = GREATEST(0, searches - 1)
  WHERE user_id = p_user_id AND usage_date = p_usage_date;
$$;

-- Only the service role may execute these (DATABASE.md §5.4). A client
-- calling them directly gets "permission denied" — proven in the tests.
REVOKE EXECUTE ON FUNCTION public.reserve_search(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_search(uuid, int) TO service_role;
REVOKE EXECUTE ON FUNCTION public.refund_search(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_search(uuid, date) TO service_role;
