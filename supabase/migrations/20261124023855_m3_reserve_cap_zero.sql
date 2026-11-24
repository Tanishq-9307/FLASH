-- M3-27: reserve_api_call must fail closed to a cap of 0.
--
-- The original INSERT ... ON CONFLICT only checked the cap on the
-- UPDATE (conflict) path: WHERE model_calls < p_cap. On a fresh day
-- there is no row to conflict with, so the INSERT ran unconditionally
-- and a cap of 0 still allowed exactly one call that day — the
-- "fails closed to 0" intent in modelCallCap was broken by one call.
-- The hole only mattered under a misconfigured cap (production cap is
-- 20), but a cap is a security boundary and must be exact.
--
-- The fix makes the INSERT itself conditional: the SELECT returns no
-- rows when p_cap < 1, so nothing is inserted and RETURNING returns
-- nothing — which the chat route already reads as "cap reached"
-- (429). A NULL cap likewise closes (WHERE NULL selects nothing).
-- The UPDATE path is unchanged: it already refuses when
-- model_calls >= p_cap, so a cap lowered mid-day after usage also
-- stays closed.

CREATE OR REPLACE FUNCTION public.reserve_api_call(p_user_id uuid, p_cap int)
RETURNS TABLE (model_calls int, usage_date date)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO api_usage (user_id, usage_date, model_calls)
  SELECT p_user_id, (now() AT TIME ZONE 'Asia/Kolkata')::date, 1
  WHERE p_cap >= 1
  ON CONFLICT (user_id, usage_date)
  DO UPDATE SET model_calls = api_usage.model_calls + 1
  WHERE api_usage.model_calls < p_cap
  RETURNING api_usage.model_calls, api_usage.usage_date;
$$;

REVOKE EXECUTE ON FUNCTION public.reserve_api_call(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_api_call(uuid, int) TO service_role;
