-- M1-4: rate-limit functions (TASKS.md M1-4, DATABASE.md §5.1, ARCHITECTURE.md §6).
--
-- Plain language: two functions the server calls (and only the server —
-- only `service_role` may execute them) to enforce the daily model-call
-- cap. `reserve_api_call` reserves one call for today in a single atomic
-- upsert: if the user already has a row for today and is under the cap it
-- increments and returns the new count; if the cap is reached it returns
-- no row, so the server knows to refuse without calling the model. Two
-- requests arriving at the same instant cannot both pass the cap, because
-- the cap check and the increment are one statement. `refund_api_call`
-- undoes one reservation on the original day, clamped at zero, and is used
-- only when the server aborts before dispatching to the provider (never
-- for provider errors). The day boundary is Asia/Kolkata midnight. Safe to
-- run twice: CREATE OR REPLACE, idempotent REVOKE/GRANT.

-- Reserve one model call for today; no row returned when the cap is hit.
CREATE OR REPLACE FUNCTION public.reserve_api_call(p_user_id uuid, p_cap int)
RETURNS TABLE (model_calls int, usage_date date)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO api_usage (user_id, usage_date, model_calls)
  VALUES (p_user_id, (now() AT TIME ZONE 'Asia/Kolkata')::date, 1)
  ON CONFLICT (user_id, usage_date)
  DO UPDATE SET model_calls = api_usage.model_calls + 1
  WHERE api_usage.model_calls < p_cap
  RETURNING api_usage.model_calls, api_usage.usage_date;
$$;

-- Refund one reservation on the original day; never below zero.
CREATE OR REPLACE FUNCTION public.refund_api_call(p_user_id uuid, p_usage_date date)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE api_usage
  SET model_calls = GREATEST(0, model_calls - 1)
  WHERE user_id = p_user_id AND usage_date = p_usage_date;
$$;

-- Only the service role may execute these (DATABASE.md §5.4). A client
-- calling them directly gets "permission denied" — proven in M1-5.
REVOKE EXECUTE ON FUNCTION public.reserve_api_call(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_api_call(uuid, int) TO service_role;
REVOKE EXECUTE ON FUNCTION public.refund_api_call(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_api_call(uuid, date) TO service_role;
