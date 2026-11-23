-- M3-1b: immutability triggers and conversation delete guard (TASKS.md
-- M3-1b, DATABASE.md §3.3, §3.8, §3.9).
--
-- Plain language: the approval and audit tables are append-only history.
-- Once a proposal exists, nobody — not even the server — may rewrite what
-- was proposed, because the whole approval system rests on the promise
-- that the parameters the owner approved are exactly the parameters that
-- run. Two triggers enforce that: the only column allowed to change on a
-- `tool_approvals` row is its status (and the bookkeeping around it), and
-- only `execution_status` / `result_payload` may change on an
-- `action_logs` row. The one exception is `conversation_id`, which may
-- change only to NULL: when a conversation is deleted, the foreign key
-- detaches the audit rows from it instead of deleting them, and that
-- update must not be blocked by the trigger. A final status (consumed,
-- rejected, expired, failed) never changes again, and
-- `outcome_delivered_at` is set exactly once.
--
-- The delete guard refuses to delete a conversation while it still has an
-- open approval (pending or approved, not yet expired), so an approval can
-- never be orphaned into an executable state with nowhere to report to.
-- An overdue approval does not block: it can no longer run. Deleting the
-- user account is allowed: when the account row is already gone (the
-- cascade that deletes the user's conversations), the guard stands down.
-- The guard is SECURITY DEFINER because it reads `auth.users`, which no
-- client role may read directly. Safe to run twice: CREATE OR REPLACE for
-- the functions, DROP TRIGGER IF EXISTS.

-- Immutability for tool_approvals (DATABASE.md §3.8).
CREATE OR REPLACE FUNCTION public.m3_approval_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.tool_name IS DISTINCT FROM OLD.tool_name
    OR NEW.tool_call_id IS DISTINCT FROM OLD.tool_call_id
    OR NEW.parameters IS DISTINCT FROM OLD.parameters
    OR NEW.parameters_hash IS DISTINCT FROM OLD.parameters_hash
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'tool_approvals: immutable columns cannot change';
  END IF;
  -- conversation_id may change only to NULL (the foreign-key action on
  -- conversation delete performs that update and must not be blocked).
  IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
    AND NEW.conversation_id IS NOT NULL THEN
    RAISE EXCEPTION 'tool_approvals: conversation_id may only become NULL';
  END IF;
  -- A final status never changes again.
  IF OLD.status IN ('consumed', 'rejected', 'expired', 'failed')
    AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'tool_approvals: final status % cannot change', OLD.status;
  END IF;
  -- outcome_delivered_at is set exactly once.
  IF OLD.outcome_delivered_at IS NOT NULL
    AND NEW.outcome_delivered_at IS DISTINCT FROM OLD.outcome_delivered_at THEN
    RAISE EXCEPTION 'tool_approvals: outcome_delivered_at is set once';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "tool_approvals_immutable" ON public.tool_approvals;
CREATE TRIGGER "tool_approvals_immutable"
  BEFORE UPDATE ON public.tool_approvals
  FOR EACH ROW EXECUTE FUNCTION public.m3_approval_immutable();

-- Immutability for action_logs (DATABASE.md §3.9). Only
-- execution_status and result_payload are ever updated, and only by the
-- approval functions (M3-2 onward).
CREATE OR REPLACE FUNCTION public.m3_log_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.tool_call_id IS DISTINCT FROM OLD.tool_call_id
    OR NEW.tool_name IS DISTINCT FROM OLD.tool_name
    OR NEW.parameters IS DISTINCT FROM OLD.parameters
    OR NEW.approval_id IS DISTINCT FROM OLD.approval_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'action_logs: immutable columns cannot change';
  END IF;
  -- conversation_id may change only to NULL (see above).
  IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
    AND NEW.conversation_id IS NOT NULL THEN
    RAISE EXCEPTION 'action_logs: conversation_id may only become NULL';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "action_logs_immutable" ON public.action_logs;
CREATE TRIGGER "action_logs_immutable"
  BEFORE UPDATE ON public.action_logs
  FOR EACH ROW EXECUTE FUNCTION public.m3_log_immutable();

-- Conversation delete guard (DATABASE.md §3.3). SECURITY DEFINER because
-- it reads auth.users, which client roles cannot read. Fixed search_path
-- so the function cannot be redirected by a crafted search_path.
CREATE OR REPLACE FUNCTION public.m3_guard_conversation_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Account deletion: the auth.users row is already gone when the cascade
  -- reaches the conversations, so the guard stands down and the delete
  -- proceeds (this is what confirms the ON DELETE NO ACTION choice for
  -- the log-to-approval foreign key).
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.user_id) THEN
    RETURN OLD;
  END IF;
  -- An open approval that has not expired blocks the delete; the owner
  -- must cancel it first. An overdue approval cannot run, so it does not
  -- block.
  IF EXISTS (
    SELECT 1 FROM public.tool_approvals
    WHERE conversation_id = OLD.id
      AND status IN ('pending', 'approved')
      AND expires_at > now()
  ) THEN
    RAISE EXCEPTION 'conversation_has_open_approval';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS "conversations_delete_guard" ON public.conversations;
CREATE TRIGGER "conversations_delete_guard"
  BEFORE DELETE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.m3_guard_conversation_delete();
