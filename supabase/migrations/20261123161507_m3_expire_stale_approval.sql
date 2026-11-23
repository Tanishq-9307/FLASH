-- M3-6: expire_stale_approval (TASKS.md M3-6, ARCHITECTURE.md §5.1,
-- §5.4, DATABASE.md §5.1).
--
-- Plain language: approvals do not expire by themselves — expiry is a
-- computed condition (`now() > expires_at`) that is only *marked* when
-- something looks at the approval. This function is the marker: the
-- server calls it (before a resume, or when a new proposal finds an
-- overdue open approval) and it flips one overdue approval from
-- `pending` or `approved` to `expired`. There is no cron job and no
-- background timer, because a timer would need somewhere to run and
-- something to wake it; instead every path that touches an approval
-- checks expiry first, so an overdue approval can never be approved or
-- executed — it is always expired first, and the expiry is recorded in
-- the log and the conversation history at that moment. The work itself
-- lives in the internal `m3_expire` helper (written in M3-2); this
-- function only exposes it to the service role, returning the approval
-- row on success and no row when the approval is not overdue (or
-- already decided, or someone else's). The return shape is an explicit
-- TABLE, not SETOF over the table: the type generator cannot name a
-- table type in the Functions section, so SETOF would break
-- `types/supabase.ts` (same adaptation as approve_action, M3-4).
-- Safe to run twice: CREATE OR REPLACE, idempotent REVOKE/GRANT.

CREATE OR REPLACE FUNCTION public.expire_stale_approval(
  p_user_id uuid,
  p_approval_id uuid
)
RETURNS TABLE(approval_id uuid, approval_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expired boolean;
BEGIN
  v_expired := public.m3_expire(p_user_id, p_approval_id);
  IF NOT v_expired THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT id, status FROM public.tool_approvals WHERE id = p_approval_id;
END;
$$;

-- Only the service role may execute it (DATABASE.md §5.4). The server
-- calls it with the service-role key; a client calling it directly gets
-- "permission denied".
REVOKE EXECUTE ON FUNCTION public.expire_stale_approval(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_approval(uuid, uuid)
  TO service_role;
