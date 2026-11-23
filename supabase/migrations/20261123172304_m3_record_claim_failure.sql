-- M3-12: record_claim_failure (TASKS.md M3-12, ARCHITECTURE.md §4.4,
-- §5.5, DATABASE.md §3.9, §5.1).
--
-- Plain language: when execute refuses a claim, the server records
-- the refusal here, in a separate transaction — because the refusal
-- itself wrote nothing, and the audit record has to survive. The
-- function always inserts one audit row in the log: execution status
-- `not_executed`, with the reason in its payload. Whether the refusal
-- was tampering is decided here, by recomputing the hash from the
-- stored parameters — the flag the caller passes in is only recorded,
-- never trusted, so a caller cannot declare tampering that did not
-- happen, nor hide tampering that did. If the parameters really were
-- changed after approval, the refusal is terminal: the approval
-- becomes `failed` (it can never run — the parameters it would run
-- are not the ones the owner approved), the original pending log is
-- settled as `not_executed` with the tamper flag, a tool message is
-- appended so the conversation records why the action will not run,
-- and the function returns a flag saying the outcome is final, so the
-- server resumes and tells the model. For any other reason the audit
-- row is all that happens: expiry and exhaustion are settled by their
-- own functions, and a refused claim for any other reason leaves the
-- approval exactly as it was. The terminal step applies while the
-- approval is still open (`pending` or `approved`); a final status
-- cannot change, so a tamper report on an already-decided approval
-- only adds the audit row.
-- Safe to run twice: CREATE OR REPLACE, idempotent REVOKE/GRANT.

CREATE OR REPLACE FUNCTION public.record_claim_failure(
  p_approval_id uuid,
  p_user_id uuid,
  p_reason text,
  p_is_tamper boolean
)
RETURNS TABLE(audit_log_id uuid, resume boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_approval public.tool_approvals%ROWTYPE;
  v_is_tamper boolean := false;
  v_audit_id uuid;
  v_resume boolean := false;
BEGIN
  -- Only an approval owned by p_user_id. A foreign approval returns
  -- no row and nothing is recorded.
  SELECT * INTO v_approval FROM public.tool_approvals
  WHERE id = p_approval_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Tamper is decided here, by recomputing the hash from the stored
  -- parameters (DATABASE.md §5.4). The caller's flag is only
  -- recorded in the audit payload, never trusted for the decision.
  v_is_tamper := v_approval.parameters_hash <>
    encode(sha256(convert_to(v_approval.parameters::text, 'UTF8')), 'hex');

  -- Always insert the audit row: execution status `not_executed`,
  -- with the reason, the decided tamper flag, and the caller's flag.
  INSERT INTO public.action_logs
    (user_id, conversation_id, tool_call_id, tool_name, parameters,
     approval_id, execution_status, result_payload)
  VALUES
    (v_approval.user_id, v_approval.conversation_id, v_approval.tool_call_id,
     v_approval.tool_name, v_approval.parameters, p_approval_id, 'not_executed',
     jsonb_build_object('reason', p_reason, 'tamper', v_is_tamper,
                        'caller_tamper_flag', p_is_tamper))
  RETURNING id INTO v_audit_id;

  -- Terminal handling for tamper, only while the approval is still
  -- open. Approved/pending -> failed is allowed; a final status
  -- cannot change.
  IF v_is_tamper AND v_approval.status IN ('pending', 'approved') THEN
    v_resume := true;
    UPDATE public.tool_approvals SET status = 'failed'
    WHERE id = p_approval_id;
    PERFORM public.m3_settle(
      p_user_id, p_approval_id, 'not_executed',
      jsonb_build_object('reason', 'hash_mismatch', 'tamper', true)
    );
    PERFORM public.m3_append_tool_message(
      p_user_id, v_approval.conversation_id, v_approval.tool_call_id,
      p_approval_id, v_approval.tool_name, 'not_executed',
      'This action will not run: the approved parameters were changed.'
    );
  END IF;

  RETURN QUERY SELECT v_audit_id, v_resume;
END;
$$;

-- Only the service role may record claim failures (DATABASE.md §5.4).
-- The server calls it with the service-role key after a refused
-- claim; a client calling it directly gets "permission denied".
REVOKE EXECUTE ON FUNCTION public.record_claim_failure(uuid, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_claim_failure(uuid, uuid, text, boolean)
  TO service_role;
