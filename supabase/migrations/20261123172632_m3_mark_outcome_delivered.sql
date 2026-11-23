-- M3-13: mark_outcome_delivered (TASKS.md M3-13, ARCHITECTURE.md §4.4,
-- §7, DATABASE.md §5.1).
--
-- Plain language: when an approval reaches a final outcome, the
-- resume route delivers that outcome to the model exactly once — and
-- "exactly once" needs a lock in the database, not a promise in the
-- server code, because two resume requests can arrive at the same
-- moment (a double tap, a retry, a parallel call). This function is
-- that lock: one conditional UPDATE stamps `outcome_delivered_at` on
-- the approval, but only if the approval is already in a final state
-- (`consumed`, `rejected`, `expired`, `failed`) and the stamp is
-- still empty. The first call wins the stamp and gets the row back;
-- every later call finds the stamp already set and gets no row, so
-- the server knows there is nothing left to deliver. A check-then-set
-- (read the stamp, then write it) would let two parallel requests
-- both read "empty" and both deliver — the single UPDATE cannot.
-- Safe to run twice: CREATE OR REPLACE, idempotent REVOKE/GRANT.

CREATE OR REPLACE FUNCTION public.mark_outcome_delivered(
  p_user_id uuid,
  p_approval_id uuid
)
RETURNS TABLE(approval_id uuid, outcome_delivered_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.tool_approvals
  SET outcome_delivered_at = now()
  WHERE id = p_approval_id
    AND user_id = p_user_id
    AND status IN ('consumed', 'rejected', 'expired', 'failed')
    AND outcome_delivered_at IS NULL
  RETURNING id, outcome_delivered_at;
END;
$$;

-- Only the service role may mark delivery (DATABASE.md §5.4). The
-- resume route calls it with the service-role key; a client calling
-- it directly gets "permission denied".
REVOKE EXECUTE ON FUNCTION public.mark_outcome_delivered(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_outcome_delivered(uuid, uuid)
  TO service_role;
