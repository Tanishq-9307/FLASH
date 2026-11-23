-- M3-2: create_pending_approval and internal helpers (TASKS.md M3-2,
-- DATABASE.md §5.1, §5.2, §5.4, ARCHITECTURE.md §5.2, §5.3, §5.8).
--
-- Plain language: when the model proposes a state-changing action, the
-- server does not execute it — it asks the database to record the proposal
-- as an approval, with a snapshot of the exact validated parameters, a
-- SHA-256 hash of those parameters, and an expiry. The hash is computed
-- inside Postgres, from the stored JSONB, so the value the server sends
-- and the value the database stores can never disagree about serialisation
-- (JavaScript and Postgres format JSON differently). The hash is computed
-- again at execution time; if the stored parameters were tampered with,
-- the hashes will not match and the action is refused as a possible
-- tamper event.
--
-- The internal helpers (no API grants — nobody may call them directly)
-- are shared by every approval function that follows: `m3_expire` marks
-- one overdue approval expired and settles its log; `m3_settle` moves a
-- pending log row to its final execution status; `m3_append_tool_message`
-- writes the tool-role history row that tells the conversation what
-- actually happened. Only `create_pending_approval` is granted, to
-- service_role: the server calls it with the service-role key, and a
-- client calling it directly gets "permission denied". Safe to run twice:
-- CREATE OR REPLACE, idempotent REVOKE/GRANT.

-- Hash of the stored parameters, computed in Postgres (ARCHITECTURE.md
-- §5.3). Pure computation, so a plain immutable function is enough.
CREATE OR REPLACE FUNCTION public.m3_params_hash(p_params jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT encode(sha256(convert_to(p_params::text, 'UTF8')), 'hex');
$$;

-- Allowlist of tools that may go through approvals (DATABASE.md §5.4).
-- The model may only propose these; anything else is refused outright.
CREATE OR REPLACE FUNCTION public.m3_is_approval_tool(p_tool text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT p_tool IN ('create_task', 'save_memory');
$$;

-- Write a tool-role history row (DATABASE.md §3.4, ARCHITECTURE.md §5.9).
-- The `parts` shape is the tool row's claim: which approval, which tool,
-- what outcome, and the human-readable result. Only the approval
-- functions write these rows, so a tool message is proof the action
-- really happened (or really was refused). Internal helper: no grants.
CREATE OR REPLACE FUNCTION public.m3_append_tool_message(
  p_user_id uuid,
  p_conversation_id uuid,
  p_tool_call_id text,
  p_approval_id uuid,
  p_tool_name text,
  p_outcome text,
  p_result text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.messages (conversation_id, user_id, role, content, parts, tool_call_id)
  VALUES (
    p_conversation_id, p_user_id, 'tool', p_result,
    jsonb_build_object(
      'approval_id', p_approval_id,
      'tool_name', p_tool_name,
      'outcome', p_outcome,
      'result', p_result
    ),
    p_tool_call_id
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Settle the pending log row for an approval (DATABASE.md §5.4). The
-- pending log is the row create_pending_approval wrote; moving it to its
-- final execution status is how the audit trail records the outcome.
-- Internal helper: no grants.
CREATE OR REPLACE FUNCTION public.m3_settle(
  p_user_id uuid,
  p_approval_id uuid,
  p_execution_status text,
  p_result_payload jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.action_logs
  SET execution_status = p_execution_status, result_payload = p_result_payload
  WHERE approval_id = p_approval_id
    AND user_id = p_user_id
    AND execution_status = 'pending';
END;
$$;

-- Expire one overdue approval (DATABASE.md §5.1, §5.2). The atomic
-- conditional UPDATE is the only thing that may move a pending or
-- approved approval to expired, and only once it is actually overdue.
-- On success it settles the pending log as not_executed and appends the
-- tool message, so the conversation already knows the outcome before any
-- resume happens. Internal helper: no grants; M3-6 exposes it as
-- expire_stale_approval.
CREATE OR REPLACE FUNCTION public.m3_expire(
  p_user_id uuid,
  p_approval_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_approval public.tool_approvals%ROWTYPE;
BEGIN
  UPDATE public.tool_approvals
  SET status = 'expired'
  WHERE id = p_approval_id
    AND user_id = p_user_id
    AND status IN ('pending', 'approved')
    AND expires_at <= now()
  RETURNING * INTO v_approval;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM public.m3_settle(
    p_user_id, p_approval_id, 'not_executed',
    jsonb_build_object('reason', 'expired')
  );
  PERFORM public.m3_append_tool_message(
    p_user_id, v_approval.conversation_id, v_approval.tool_call_id,
    p_approval_id, v_approval.tool_name, 'expired',
    'The proposed action expired before it was decided.'
  );
  RETURN true;
END;
$$;

-- create_pending_approval (DATABASE.md §5.2): record a proposal.
-- Steps: refuse unknown tools and TTLs outside 1–3600 seconds; expire an
-- overdue open approval for the conversation (same logic as
-- expire_stale_approval, including its log and tool message); refuse if a
-- live open approval remains; insert the approval (Postgres computes the
-- expiry and the hash) and the pending log in one transaction; catch the
-- unique_violation from the one-open-approval index (two simultaneous
-- proposals) and return open_approval_exists. Returns one row:
-- ('created', approval_id, log_id) or ('open_approval_exists', NULL, NULL).
CREATE OR REPLACE FUNCTION public.create_pending_approval(
  p_user_id uuid,
  p_conversation_id uuid,
  p_tool_call_id text,
  p_tool text,
  p_params jsonb,
  p_ttl_seconds int
)
RETURNS TABLE(result_code text, approval_id uuid, log_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_open_id uuid;
  v_approval_id uuid;
  v_log_id uuid;
BEGIN
  IF NOT public.m3_is_approval_tool(p_tool) THEN
    RAISE EXCEPTION 'create_pending_approval: unknown tool %', p_tool;
  END IF;
  IF p_ttl_seconds < 1 OR p_ttl_seconds > 3600 THEN
    RAISE EXCEPTION 'create_pending_approval: TTL must be 1..3600 seconds, got %', p_ttl_seconds;
  END IF;

  -- At most one open approval per conversation (partial unique index), so
  -- this finds zero or one row. An overdue one is expired (and settled)
  -- here; a live one refuses the new proposal.
  SELECT id INTO v_open_id FROM public.tool_approvals
  WHERE conversation_id = p_conversation_id
    AND user_id = p_user_id
    AND status IN ('pending', 'approved')
  LIMIT 1;
  IF v_open_id IS NOT NULL THEN
    IF NOT public.m3_expire(p_user_id, v_open_id) THEN
      RETURN QUERY SELECT 'open_approval_exists'::text, NULL::uuid, NULL::uuid;
      RETURN;
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.tool_approvals
      (user_id, conversation_id, tool_call_id, tool_name, parameters, parameters_hash, expires_at)
    VALUES (
      p_user_id, p_conversation_id, p_tool_call_id, p_tool, p_params,
      public.m3_params_hash(p_params),
      now() + make_interval(secs => p_ttl_seconds)
    )
    RETURNING id INTO v_approval_id;

    INSERT INTO public.action_logs
      (user_id, conversation_id, approval_id, tool_call_id, tool_name, parameters, execution_status)
    VALUES (
      p_user_id, p_conversation_id, v_approval_id, p_tool_call_id, p_tool, p_params, 'pending'
    )
    RETURNING id INTO v_log_id;
  EXCEPTION WHEN unique_violation THEN
    -- A racing proposal won the index first: refuse, do not raise.
    RETURN QUERY SELECT 'open_approval_exists'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END;

  RETURN QUERY SELECT 'created'::text, v_approval_id, v_log_id;
  RETURN;
END;
$$;

-- Only the service role may execute it (DATABASE.md §5.4). The internal
-- helpers are granted to nobody: they run only inside other SECURITY
-- DEFINER functions.
REVOKE EXECUTE ON FUNCTION public.create_pending_approval(uuid, uuid, text, text, jsonb, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_pending_approval(uuid, uuid, text, text, jsonb, int)
  TO service_role;
