-- M3-7: execute_approved_action (1 of 4) — claim and classification
-- (TASKS.md M3-7, ARCHITECTURE.md §5.4–§5.7, DATABASE.md §5.1, §5.3).
--
-- Plain language: this is the moment an approved action actually runs.
-- It does three things, in order, inside one transaction. First it
-- *claims* the approval: a single conditional UPDATE flips it from
-- `approved` to `consumed`, but only if it is still approved, still
-- unexpired, has retries left, and the stored parameters still hash to
-- the hash recorded at creation. One UPDATE, not a SELECT then an
-- UPDATE, because five parallel requests could all read "approved" and
-- all proceed — with one conditional UPDATE exactly one wins the claim
-- and the rest get no row. Second, if the claim returned no row, it
-- *classifies* why, by reading the approval row: already decided
-- (`replay`), never approved (`not_approved`), overdue (`expired`),
-- retries used up (`exhausted`), or parameters tampered with
-- (`hash_mismatch`). That read only names the reason — it never
-- authorises anything, and no writes happen on that path. Third, it
-- *dispatches* on the tool name through a hardcoded branch. In this
-- task the dispatch is a temporary placeholder: it returns success for
-- the two known tool names (`create_task`, `save_memory`) without
-- writing anything, and raises for unknown names. The real branches
-- land in M3-8 (create_task) and M3-9 (save_memory), including the log
-- update and the tool message — so in this task a claimed approval has
-- status `consumed` while its log stays `pending` by design; M3-8
-- completes the epilogue. The whole claim, dispatch and every later
-- write sit inside one BEGIN ... EXCEPTION block: any error rolls
-- everything back, including the claim, and the function returns
-- `tool_error` with a sanitised payload — only the code, never SQL
-- text or internals, so nothing about the database can leak to the
-- caller. The server then calls record_execution_failure (M3-11) in a
-- separate call, because a counter incremented inside the rolled-back
-- transaction would vanish with it. Authenticated only, and the claim
-- learns the caller from `auth.uid()`, never from a parameter.
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
      -- writes, never an authorisation check. The order follows the
      -- claim's own conditions: status, then expiry, then retries,
      -- then the hash. A foreign approval reads as "not found" here
      -- (the read is scoped to auth.uid()), so nothing leaks about
      -- another user's approvals.
      SELECT * INTO v_approval FROM public.tool_approvals
      WHERE id = p_approval_id AND user_id = auth.uid();
      IF NOT FOUND THEN
        RETURN QUERY SELECT 'not_approved'::text, NULL::jsonb;
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
      IF v_approval.retry_count >= 3 THEN
        RETURN QUERY SELECT 'exhausted'::text, NULL::jsonb;
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

    -- Dispatch (M3-7 stub): known tools return success without
    -- writing anything; unknown tools raise, which the EXCEPTION
    -- block below turns into tool_error with the claim rolled back.
    -- Real branches replace this stub in M3-8 (create_task) and
    -- M3-9 (save_memory).
    IF v_approval.tool_name IN ('create_task', 'save_memory') THEN
      RETURN QUERY SELECT 'claimed'::text,
        jsonb_build_object('tool', v_approval.tool_name);
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
