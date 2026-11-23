-- M3-11 fix: classification order in execute_approved_action
-- (TASKS.md M3-11, DATABASE.md §5.3 step 2, ARCHITECTURE.md §5.5).
--
-- Plain language: the M3-7 classification checked the approval's
-- status first, so a `failed` approval always returned `replay` —
-- including one that failed because it ran out of retries. But the
-- M3-11 test requires that exact case to return `exhausted`: after
-- the third failure the approval is `failed` with `retry_count` 3,
-- and a later execution must say the retries are used up, not that
-- the action was already run. Neither DATABASE.md §5.3 step 2 nor
-- ARCHITECTURE.md §5.5 pins the order between these two codes — they
-- only list them — so the order is fixed here: the retry check now
-- comes before the terminal-status check. Nothing else changes. A
-- `failed` approval with retries left (for example one failed for
-- tampering, which record_claim_failure sets to `failed` with its
-- retry count untouched) still returns `replay`; only
-- `retry_count >= 3` returns `exhausted`. The claim itself is
-- unchanged: it still requires status `approved`, unexpired,
-- retries left, and a matching hash, in one conditional UPDATE.
-- Safe to run twice: CREATE OR REPLACE, idempotent REVOKE/GRANT.

CREATE OR REPLACE FUNCTION public.execute_approved_action(
  p_approval_id uuid
)
RETURNS TABLE(result_code text, result_payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_approval public.tool_approvals%ROWTYPE;
  v_claimed boolean := false;
  v_title text;
  v_due_raw text;
  v_due_date timestamptz;
  v_task_id uuid;
  v_fact text;
  v_memory_id uuid;
BEGIN
  BEGIN
    -- Claim (ARCHITECTURE.md §5.4): one conditional UPDATE. The hash
    -- is recomputed from the stored parameters here, in Postgres, and
    -- compared with the hash recorded at creation — so a tampered
    -- parameter set fails the claim even though the row itself was
    -- never re-validated.
    UPDATE public.tool_approvals
    SET status = 'consumed', consumed_at = now()
    WHERE id = p_approval_id
      AND user_id = auth.uid()
      AND status = 'approved'
      AND expires_at > now()
      AND retry_count < 3
      AND parameters_hash = encode(sha256(convert_to(parameters::text, 'UTF8')), 'hex')
    RETURNING * INTO v_approval;
    IF FOUND THEN
      v_claimed := true;
    END IF;

    IF NOT v_claimed THEN
      -- Classification (DATABASE.md §5.3 step 2): read only, no
      -- writes, never an authorisation check. The retry check comes
      -- first: a failed approval that ran out of retries must say
      -- `exhausted`, while a failed approval with retries left (for
      -- example tampering) still says `replay`. A foreign approval
      -- reads as "not found" here (the read is scoped to
      -- auth.uid()), so nothing leaks about another user's approvals.
      SELECT * INTO v_approval FROM public.tool_approvals
      WHERE id = p_approval_id AND user_id = auth.uid();
      IF NOT FOUND THEN
        RETURN QUERY SELECT 'not_approved'::text, NULL::jsonb;
        RETURN;
      END IF;
      IF v_approval.retry_count >= 3 THEN
        RETURN QUERY SELECT 'exhausted'::text, NULL::jsonb;
        RETURN;
      END IF;
      IF v_approval.status IN ('consumed', 'rejected', 'failed') THEN
        RETURN QUERY SELECT 'replay'::text, NULL::jsonb;
        RETURN;
      END IF;
      IF v_approval.status = 'pending' THEN
        RETURN QUERY SELECT 'not_approved'::text, NULL::jsonb;
        RETURN;
      END IF;
      IF v_approval.expires_at <= now() THEN
        RETURN QUERY SELECT 'expired'::text, NULL::jsonb;
        RETURN;
      END IF;
      IF v_approval.parameters_hash <> encode(sha256(convert_to(v_approval.parameters::text, 'UTF8')), 'hex') THEN
        RETURN QUERY SELECT 'hash_mismatch'::text, NULL::jsonb;
        RETURN;
      END IF;
      -- Approved, unexpired, hash matches, retries left: the claim
      -- should have succeeded. Unreachable in practice; fail closed.
      RETURN QUERY SELECT 'not_approved'::text, NULL::jsonb;
      RETURN;
    END IF;

    -- Dispatch: hardcoded branch per tool (ARCHITECTURE.md §5.6). No
    -- SQL is ever built from stored parameter text.
    IF v_approval.tool_name = 'create_task' THEN
      -- Validate the stored parameters again in SQL. The title must
      -- be present and non-empty; the due date, when given, must
      -- parse. The 255-character limit is enforced by the tasks
      -- table's CHECK — the second validation layer — so an
      -- over-length title fails the insert and the whole transaction
      -- rolls back (M3-10 forces exactly that).
      v_title := NULLIF(btrim(v_approval.parameters->>'title'), '');
      IF v_title IS NULL THEN
        RAISE EXCEPTION 'execute: create_task requires a non-empty title';
      END IF;
      v_due_raw := v_approval.parameters->>'due_date';
      IF v_due_raw IS NOT NULL THEN
        v_due_date := v_due_raw::timestamptz;
      END IF;

      INSERT INTO public.tasks (user_id, title, due_date)
      VALUES (v_approval.user_id, v_title, v_due_date)
      RETURNING id INTO v_task_id;

      PERFORM public.m3_settle(
        v_approval.user_id, p_approval_id, 'succeeded',
        jsonb_build_object('task_id', v_task_id, 'title', v_title)
      );
      PERFORM public.m3_append_tool_message(
        v_approval.user_id, v_approval.conversation_id, v_approval.tool_call_id,
        p_approval_id, 'create_task', 'succeeded',
        'Created task "' || v_title || '".'
      );
      RETURN QUERY SELECT 'claimed'::text,
        jsonb_build_object('task_id', v_task_id, 'title', v_title);
      RETURN;
    ELSIF v_approval.tool_name = 'save_memory' THEN
      -- Validate the stored fact again in SQL. It must be present
      -- and non-empty after trimming; the 10,000-character limit is
      -- enforced by the memories table's CHECK — the second
      -- validation layer — so an over-length fact fails the insert
      -- and the whole transaction rolls back.
      v_fact := NULLIF(btrim(v_approval.parameters->>'fact'), '');
      IF v_fact IS NULL THEN
        RAISE EXCEPTION 'execute: save_memory requires a non-empty fact';
      END IF;

      INSERT INTO public.memories (user_id, fact)
      VALUES (v_approval.user_id, v_fact)
      RETURNING id INTO v_memory_id;

      PERFORM public.m3_settle(
        v_approval.user_id, p_approval_id, 'succeeded',
        jsonb_build_object('memory_id', v_memory_id)
      );
      PERFORM public.m3_append_tool_message(
        v_approval.user_id, v_approval.conversation_id, v_approval.tool_call_id,
        p_approval_id, 'save_memory', 'succeeded',
        'Saved memory "' || v_fact || '".'
      );
      RETURN QUERY SELECT 'claimed'::text,
        jsonb_build_object('memory_id', v_memory_id);
      RETURN;
    ELSE
      RAISE EXCEPTION 'execute_approved_action: unknown tool %', v_approval.tool_name;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Every write in the block, including the claim, rolls back, so
    -- a failed dispatch leaves the approval `approved` with its
    -- retry count untouched. The payload carries only the code —
    -- never SQLERRM, so no SQL text or internals can leak.
    RETURN QUERY SELECT 'tool_error'::text,
      jsonb_build_object('error', 'tool_error');
    RETURN;
  END;
END;
$$;

-- Only authenticated users may execute it (DATABASE.md §5.4). The
-- server calls it through the user-scoped client from the Server
-- Actions; a client calling it without a login gets "permission
-- denied".
REVOKE EXECUTE ON FUNCTION public.execute_approved_action(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.execute_approved_action(uuid)
  TO authenticated;
