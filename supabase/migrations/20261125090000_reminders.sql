-- Smart reminders (Phase 3, 2026-11-25): the `reminders` table,
-- the atomic claim function the delivery cron uses, and the
-- `create_reminder` branch of execute_approved_action.
--
-- Plain language: the owner asks for a reminder in chat ("remind me
-- tomorrow at 9am to submit the form"), over Telegram (/remind), or
-- on the Reminders screen. A reminder is one row: what to say, when
-- (a timestamptz, always stored in UTC, displayed in Asia/Kolkata),
-- and a status. The delivery cron claims due rows, sends each over
-- Telegram, and marks it sent — the claim is one conditional UPDATE,
-- so two cron runs can never send the same reminder twice.
--
-- Statuses: pending (waiting for its time), sending (claimed by a
-- run that has not finished yet), sent, cancelled. A `sending` row
-- whose run died is reclaimed after 10 minutes, so a crashed run
-- delays a reminder instead of losing it.
--
-- Quiet hours do NOT apply to reminders: the owner asked for that
-- exact time, so a reminder is not an unsolicited nudge (the
-- proactive engine's quiet hours still apply to its own nudges).
-- The runner (lib/telegram/run-reminders.ts) documents this.
--
-- Chat creation goes through the approval flow like create_task:
-- the model proposes, the owner approves in the web app, and only
-- then does this branch insert the row. The branch validates the
-- stored parameters again in SQL (message non-empty, remind_at
-- present, parseable, and in the future); the 500-character message
-- limit is left to the table CHECK, the second validation layer.
-- Safe to run twice: IF NOT EXISTS / CREATE OR REPLACE, idempotent
-- REVOKE/GRANT.

-- The table. `source` records where the reminder came from (web
-- screen, chat approval, Telegram command) for the activity log.
CREATE TABLE IF NOT EXISTS public.reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL
    REFERENCES auth.users (id) ON DELETE CASCADE,
  message text NOT NULL
    CHECK (char_length(message) >= 1 AND char_length(message) <= 500),
  remind_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'cancelled')),
  source text NOT NULL DEFAULT 'web'
    CHECK (source IN ('web', 'chat', 'telegram')),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

-- The owner manages only their own reminders: read, create, cancel
-- (UPDATE of status), delete. No UPDATE of message/remind_at is
-- offered by the app — a reminder is corrected by deleting it and
-- creating a new one, so a row's time can never silently change
-- after the owner set it.
DROP POLICY IF EXISTS "reminders_owner_select" ON public.reminders;
CREATE POLICY "reminders_owner_select" ON public.reminders
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "reminders_owner_insert" ON public.reminders;
CREATE POLICY "reminders_owner_insert" ON public.reminders
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "reminders_owner_update" ON public.reminders;
CREATE POLICY "reminders_owner_update" ON public.reminders
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "reminders_owner_delete" ON public.reminders;
CREATE POLICY "reminders_owner_delete" ON public.reminders
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- The delivery cron's due query: pending rows for one user, by time.
CREATE INDEX IF NOT EXISTS reminders_due_idx
  ON public.reminders (user_id, status, remind_at);

DROP TRIGGER IF EXISTS reminders_set_updated_at ON public.reminders;
CREATE TRIGGER reminders_set_updated_at
  BEFORE UPDATE ON public.reminders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Explicit grants (DATABASE.md §4): revoke the broad Supabase
-- defaults, then grant exactly what each role needs.
REVOKE ALL ON public.reminders FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reminders TO authenticated;

-- Stop future objects from regressing to broad defaults.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- Claim due reminders, atomically (service role only). One UPDATE
-- claims every pending row whose time has come, plus any `sending`
-- row abandoned by a run more than 10 minutes ago, and returns the
-- claimed rows. The caller sends each one, then marks it sent (or
-- releases it back to pending on a send failure). Because the claim
-- is a single statement, two concurrent cron runs claim disjoint
-- sets — a reminder is never sent twice.
-- RETURNS TABLE, not SETOF over the table: the type generator
-- cannot name a table type in the Functions section, so SETOF would
-- break `types/supabase.ts` (see approve_action).
CREATE OR REPLACE FUNCTION public.claim_due_reminders(p_now timestamptz)
RETURNS TABLE(
  id uuid,
  user_id uuid,
  message text,
  remind_at timestamptz,
  status text,
  source text,
  sent_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.reminders
  SET status = 'sending', updated_at = p_now
  WHERE (status = 'pending' AND remind_at <= p_now)
     OR (status = 'sending' AND updated_at < p_now - interval '10 minutes')
  RETURNING reminders.*;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_due_reminders(timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_reminders(timestamptz)
  TO service_role;

-- The approval allowlist gains create_reminder (DATABASE.md §5.4).
CREATE OR REPLACE FUNCTION public.m3_is_approval_tool(p_tool text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT p_tool IN ('create_task', 'save_memory', 'create_reminder');
$$;

-- execute_approved_action with the create_reminder branch (4th
-- tool). This is the full current function (claim + retry-first
-- classification from the M3-11 fix, create_task and save_memory
-- branches unchanged) plus the new branch. The branch validates the
-- stored parameters again in SQL: a non-empty message, a present
-- and parseable remind_at in the future (a reminder whose time
-- already passed while the approval waited would fire immediately
-- on the next cron run, so it fails instead), and the 500-character
-- limit is enforced by the reminders table CHECK. The row is written
-- with the approval's user_id and source 'chat'.
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
  v_message text;
  v_remind_raw text;
  v_remind_at timestamptz;
  v_reminder_id uuid;
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
    ELSIF v_approval.tool_name = 'create_reminder' THEN
      -- Validate the stored parameters again in SQL. The message
      -- must be present and non-empty after trimming; remind_at
      -- must be present, parseable, and in the future — a reminder
      -- whose time already passed while the approval waited would
      -- fire immediately on the next cron run, so it fails instead
      -- and the owner can ask again with a fresh time. The
      -- 500-character limit is enforced by the reminders table's
      -- CHECK — the second validation layer.
      v_message := NULLIF(btrim(v_approval.parameters->>'message'), '');
      IF v_message IS NULL THEN
        RAISE EXCEPTION 'execute: create_reminder requires a non-empty message';
      END IF;
      v_remind_raw := v_approval.parameters->>'remind_at';
      IF v_remind_raw IS NULL THEN
        RAISE EXCEPTION 'execute: create_reminder requires remind_at';
      END IF;
      v_remind_at := v_remind_raw::timestamptz;
      IF v_remind_at <= now() THEN
        RAISE EXCEPTION 'execute: create_reminder remind_at must be in the future';
      END IF;

      INSERT INTO public.reminders (user_id, message, remind_at, source)
      VALUES (v_approval.user_id, v_message, v_remind_at, 'chat')
      RETURNING id INTO v_reminder_id;

      PERFORM public.m3_settle(
        v_approval.user_id, p_approval_id, 'succeeded',
        jsonb_build_object('reminder_id', v_reminder_id, 'message', v_message, 'remind_at', v_remind_at)
      );
      PERFORM public.m3_append_tool_message(
        v_approval.user_id, v_approval.conversation_id, v_approval.tool_call_id,
        p_approval_id, 'create_reminder', 'succeeded',
        'Set a reminder: "' || v_message || '".'
      );
      RETURN QUERY SELECT 'claimed'::text,
        jsonb_build_object('reminder_id', v_reminder_id, 'message', v_message, 'remind_at', v_remind_at);
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
