-- M3-4: approve_action (TASKS.md M3-4, ARCHITECTURE.md §5.4,
-- DATABASE.md §5.1).
--
-- Plain language: this is the owner's "yes" — the Approve button in the
-- dialog calls it. It moves one approval from `pending` to `approved`,
-- once, and only before its expiry. The whole transition is a single
-- conditional UPDATE: the row is claimed only if it is still pending,
-- still unexpired, and owned by the caller. That matters because two
-- parallel requests (a double-tap, a retry) can both read "pending" and
-- both try to approve — with a separate SELECT then UPDATE both would
-- succeed, but with one conditional UPDATE exactly one wins and the
-- other gets no row back. The function learns the caller from
-- `auth.uid()`, never from a parameter, so a caller can only ever
-- approve their own proposals. Authenticated only: a client calling it
-- without a login gets "permission denied". It returns the approval row
-- on success and no row when the approval is expired, already decided,
-- or someone else's — the server treats "no row" as a refusal, never as
-- an error to retry blindly. The return shape is an explicit TABLE, not
-- SETOF over the table: the type generator cannot name a table type in
-- the Functions section, so SETOF would break `types/supabase.ts`.
-- Safe to run twice: CREATE OR REPLACE, idempotent REVOKE/GRANT.

CREATE OR REPLACE FUNCTION public.approve_action(
  p_approval_id uuid
)
RETURNS TABLE(approval_id uuid, approval_status text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.tool_approvals
  SET status = 'approved', approved_at = now()
  WHERE id = p_approval_id
    AND user_id = auth.uid()
    AND status = 'pending'
    AND expires_at > now()
  RETURNING id, status;
$$;

-- Only authenticated users may execute it (DATABASE.md §5.4). The
-- service role does not need it: approvals are the owner's decision,
-- never the server's.
REVOKE EXECUTE ON FUNCTION public.approve_action(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_action(uuid)
  TO authenticated;
