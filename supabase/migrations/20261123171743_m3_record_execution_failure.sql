-- M3-11: record_execution_failure (TASKS.md M3-11, ARCHITECTURE.md
-- §5.5, §5.7, DATABASE.md §5.1, §5.3 step 6).
--
-- Plain language: when a tool write fails, execute_approved_action
-- rolls its whole transaction back — including the claim — so the
-- approval is `approved` again and nothing about the failure survives
-- inside that transaction. The failure still has to be counted,
-- because three failures in a row mean the action is done and the
-- owner should be told. This function is that count, in a separate
-- transaction the server starts after execute returns. It only works
-- on an `approved` approval owned by the user id it is given: it adds
-- one to `retry_count` and records the sanitised error in the pending
-- log's payload (the log stays pending, because the action may still
-- run on a retry). On the third failure the approval is terminal: its
-- status becomes `failed`, the log becomes `failed` with the error,
-- and a tool message is appended so the conversation records that the
-- action could not be completed — and the function returns a flag
-- saying the outcome is final, so the server knows to resume the
-- conversation and tell the model. The error it records is the one the
-- server passes in; the server only ever receives the sanitised code
-- from execute, so no SQL text or internals can reach this function.
-- Safe to run twice: CREATE OR REPLACE, idempotent REVOKE/GRANT.

CREATE OR REPLACE FUNCTION public.record_execution_failure(
  p_approval_id uuid,
  p_user_id uuid,
  p_error jsonb
)
RETURNS TABLE(retry_count integer, failed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_approval public.tool_approvals%ROWTYPE;
  v_new_count integer;
  v_failed boolean := false;
BEGIN
  -- Only an approved approval owned by p_user_id. The conditional
  -- UPDATE is the whole guard: a foreign approval, or one already
  -- decided, returns no row and nothing changes.
  UPDATE public.tool_approvals
  SET retry_count = tool_approvals.retry_count + 1
  WHERE id = p_approval_id
    AND user_id = p_user_id
    AND status = 'approved'
  RETURNING * INTO v_approval;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  v_new_count := v_approval.retry_count;

  IF v_new_count >= 3 THEN
    -- Terminal: approved -> failed is allowed (approved is not a
    -- final status). The log is settled as failed with the sanitised
    -- error, and the tool message records the outcome for the
    -- conversation.
    v_failed := true;
    UPDATE public.tool_approvals SET status = 'failed'
    WHERE id = p_approval_id;
    PERFORM public.m3_settle(p_user_id, p_approval_id, 'failed', p_error);
    PERFORM public.m3_append_tool_message(
      p_user_id, v_approval.conversation_id, v_approval.tool_call_id,
      p_approval_id, v_approval.tool_name, 'failed',
      'The action failed after 3 attempts.'
    );
  ELSE
    -- Non-terminal: the log stays pending (the action may still run
    -- on a retry) and the sanitised error is recorded in its payload.
    UPDATE public.action_logs
    SET result_payload = p_error
    WHERE approval_id = p_approval_id
      AND user_id = p_user_id
      AND execution_status = 'pending';
  END IF;

  RETURN QUERY SELECT v_new_count, v_failed;
END;
$$;

-- Only the service role may record failures (DATABASE.md §5.4). The
-- server calls it with the service-role key after a tool_error; a
-- client calling it directly gets "permission denied".
REVOKE EXECUTE ON FUNCTION public.record_execution_failure(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_execution_failure(uuid, uuid, jsonb)
  TO service_role;
