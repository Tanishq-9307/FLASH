-- Usage meters, no hard caps (owner requirement 2026-11-24).
--
-- Plain language: the app-level caps are gone — chat and search must
-- never hard-stop at an app-level limit; the provider's own limit is
-- the real ceiling (Groq 1,000 requests/day for chat, Tavily 1,000
-- credits/month for search). What stays is the counting, because the
-- usage meters need it. Two new functions, both unconditional:
-- `record_api_call` increments today's model-call count by one, no
-- cap check, no refusal; `record_search` increments today's search
-- count by one, likewise. Each is a single atomic upsert (insert the
-- row, or increment the existing one), so two requests arriving at
-- the same instant cannot lose a count. The day boundary is
-- Asia/Kolkata midnight, like the functions they replace.
-- `reserve_api_call` and `reserve_search` are LEFT in the database
-- unused — no code calls them after this migration; they stay only so
-- the old DB tests keep proving their shape, and so a rollback is a
-- code change, not a migration. `refund_api_call` and `refund_search`
-- are unchanged and still used for pre-dispatch aborts (clamped at
-- zero). Only the service role may execute the new functions
-- (DATABASE.md §5.4). Safe to run twice: CREATE OR REPLACE,
-- idempotent REVOKE/GRANT.

-- Record one model call for today, unconditionally.
CREATE OR REPLACE FUNCTION public.record_api_call(p_user_id uuid)
RETURNS TABLE (model_calls int, usage_date date)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO api_usage (user_id, usage_date, model_calls)
  VALUES (p_user_id, (now() AT TIME ZONE 'Asia/Kolkata')::date, 1)
  ON CONFLICT (user_id, usage_date)
  DO UPDATE SET model_calls = api_usage.model_calls + 1
  RETURNING api_usage.model_calls, api_usage.usage_date;
$$;

-- Record one web search for today, unconditionally.
CREATE OR REPLACE FUNCTION public.record_search(p_user_id uuid)
RETURNS TABLE (searches int, usage_date date)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO search_usage (user_id, usage_date, searches)
  VALUES (p_user_id, (now() AT TIME ZONE 'Asia/Kolkata')::date, 1)
  ON CONFLICT (user_id, usage_date)
  DO UPDATE SET searches = search_usage.searches + 1
  RETURNING search_usage.searches, search_usage.usage_date;
$$;

-- Only the service role may execute these (DATABASE.md §5.4). A client
-- calling them directly gets "permission denied" — proven in the tests.
REVOKE EXECUTE ON FUNCTION public.record_api_call(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_api_call(uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.record_search(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_search(uuid) TO service_role;
