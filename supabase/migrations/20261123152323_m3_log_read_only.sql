-- M3-3: log_read_only_action (TASKS.md M3-3, DATABASE.md §5.1,
-- ARCHITECTURE.md §4.4).
--
-- Plain language: read-only tool calls never need the owner's approval —
-- they change nothing — but they still have to leave a paper trail. This
-- function is the only way the server writes that trail: one audit row in
-- `action_logs` recording who ran what, with which parameters, and
-- whether it worked. The `approval_id` stays NULL because there was no
-- approval to record. Two guards keep the trail honest: the status may
-- only be `succeeded` or `failed` (a read-only call is never `pending`),
-- and a state-changing tool name (`create_task`, `save_memory`) is
-- refused outright — those must go through `create_pending_approval`
-- instead, so a bug or an injection can never smuggle a write past the
-- approval step by logging it as a read. Only the service role may call
-- it: the server calls it with the service-role key, and a client calling
-- it directly gets "permission denied". Safe to run twice: CREATE OR
-- REPLACE, idempotent REVOKE/GRANT.

CREATE OR REPLACE FUNCTION public.log_read_only_action(
  p_user_id uuid,
  p_conversation_id uuid,
  p_tool_call_id text,
  p_tool text,
  p_params jsonb,
  p_status text,
  p_result jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_log_id uuid;
BEGIN
  IF public.m3_is_approval_tool(p_tool) THEN
    RAISE EXCEPTION 'log_read_only_action: state-changing tool % must go through approvals', p_tool;
  END IF;
  IF p_status NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'log_read_only_action: status must be succeeded or failed, got %', p_status;
  END IF;

  INSERT INTO public.action_logs
    (user_id, conversation_id, approval_id, tool_call_id, tool_name, parameters, execution_status, result_payload)
  VALUES
    (p_user_id, p_conversation_id, NULL, p_tool_call_id, p_tool, p_params, p_status, p_result)
  RETURNING id INTO v_log_id;

  RETURN v_log_id;
END;
$$;

-- Only the service role may execute it (DATABASE.md §5.4).
REVOKE EXECUTE ON FUNCTION public.log_read_only_action(uuid, uuid, text, text, jsonb, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_read_only_action(uuid, uuid, text, text, jsonb, text, jsonb)
  TO service_role;
