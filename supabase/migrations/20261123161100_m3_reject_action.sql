-- M3-5: reject_action (TASKS.md M3-5, ARCHITECTURE.md §5.4, §5.9,
-- DATABASE.md §5.1).
--
-- Plain language: this is the owner's "no" — the Cancel button in the
-- dialog calls it. It moves one approval from `pending` or `approved` to
-- `rejected`, once, and only before its expiry. Cancelling is allowed
-- from `approved` as well as `pending` because approval is not
-- execution: nothing has run yet, so cancelling only discards the
-- permission to run it. The whole transition is a single conditional
-- UPDATE: the row is cancelled only if it is still undecided, still
-- unexpired, and owned by the caller. Two parallel requests (a double
-- tap, a retry) can both read "pending" and both try to cancel — with
-- one conditional UPDATE exactly one wins and the other gets no row
-- back. On success the function settles the pending log as
-- `not_executed` and appends the tool message, so the conversation
-- already knows the outcome before any resume happens. The function
-- learns the caller from `auth.uid()`, never from a parameter, so a
-- caller can only ever cancel their own proposals. Authenticated only:
-- a client calling it without a login gets "permission denied". It
-- returns the approval row on success and no row when the approval is
-- expired, already decided, or someone else's. The return shape is an
-- explicit TABLE, not SETOF over the table: the type generator cannot
-- name a table type in the Functions section, so SETOF would break
-- `types/supabase.ts` (same adaptation as approve_action, M3-4).
-- Safe to run twice: CREATE OR REPLACE, idempotent REVOKE/GRANT.

CREATE OR REPLACE FUNCTION public.reject_action(
  p_approval_id uuid
)
RETURNS TABLE(approval_id uuid, approval_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_approval public.tool_approvals%ROWTYPE;
BEGIN
  UPDATE public.tool_approvals
  SET status = 'rejected'
  WHERE id = p_approval_id
    AND user_id = auth.uid()
    AND status IN ('pending', 'approved')
    AND expires_at > now()
  RETURNING * INTO v_approval;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM public.m3_settle(
    auth.uid(), p_approval_id, 'not_executed',
    jsonb_build_object('reason', 'rejected')
  );
  PERFORM public.m3_append_tool_message(
    auth.uid(), v_approval.conversation_id, v_approval.tool_call_id,
    p_approval_id, v_approval.tool_name, 'rejected',
    'The proposed action was cancelled.'
  );
  RETURN QUERY SELECT v_approval.id, v_approval.status;
END;
$$;

-- Only authenticated users may execute it (DATABASE.md §5.4). The
-- service role does not need it: cancelling is the owner's decision,
-- never the server's.
REVOKE EXECUTE ON FUNCTION public.reject_action(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_action(uuid)
  TO authenticated;
