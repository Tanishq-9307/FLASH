-- M3-1a: memories, tool_approvals, action_logs tables (TASKS.md M3-1a,
-- DATABASE.md §3.7–3.9, §4).
--
-- Plain language: these are the three tables the approval system stands
-- on. `memories` holds facts the owner (or an approved tool) saved; the
-- owner can read, add, edit and delete them on the Memory screen.
-- `tool_approvals` holds every proposed action as an immutable snapshot:
-- the tool name, the exact validated parameters, a SHA-256 hash of those
-- parameters computed by Postgres itself, a status, a retry count and an
-- expiry. `action_logs` is the audit trail: one row per tool execution
-- attempt, recording what happened and whether it succeeded. Audit rows
-- survive conversation deletion — the foreign keys null only the
-- conversation link, never the row itself — because a deleted conversation
-- must never erase the record of what the assistant did in it. Clients
-- may only SELECT the two security tables; every write goes through a
-- database function (M3-2 onward). Safe to run twice: IF NOT EXISTS,
-- DROP POLICY / DROP INDEX / DROP TRIGGER IF EXISTS, idempotent
-- REVOKE/GRANT.

-- memories (DATABASE.md §3.7): owner-editable facts. The fact must be
-- non-empty after trimming and at most 10,000 characters.
CREATE TABLE IF NOT EXISTS public.memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid()
    REFERENCES auth.users (id) ON DELETE CASCADE,
  fact text NOT NULL CHECK (char_length(btrim(fact)) BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);

CREATE INDEX IF NOT EXISTS "memories_user_id_idx"
  ON public.memories (user_id);

ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "memories_owner_select" ON public.memories;
CREATE POLICY "memories_owner_select" ON public.memories
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "memories_owner_insert" ON public.memories;
CREATE POLICY "memories_owner_insert" ON public.memories
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "memories_owner_update" ON public.memories;
CREATE POLICY "memories_owner_update" ON public.memories
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "memories_owner_delete" ON public.memories;
CREATE POLICY "memories_owner_delete" ON public.memories
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP TRIGGER IF EXISTS "memories_set_updated_at" ON public.memories;
CREATE TRIGGER "memories_set_updated_at"
  BEFORE UPDATE ON public.memories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- tool_approvals (DATABASE.md §3.8): immutable proposal snapshots.
-- parameters_hash is computed by Postgres at creation (M3-2) and again
-- at execution, so the hash can never disagree with the stored JSONB
-- because of a JavaScript/Postgres serialisation difference.
CREATE TABLE IF NOT EXISTS public.tool_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid()
    REFERENCES auth.users (id) ON DELETE CASCADE,
  conversation_id uuid,
  tool_call_id text NOT NULL CHECK (char_length(tool_call_id) <= 128),
  tool_name text NOT NULL CHECK (char_length(tool_name) <= 64),
  parameters jsonb NOT NULL,
  parameters_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'consumed', 'rejected', 'expired', 'failed')),
  retry_count int NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 3),
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  consumed_at timestamptz,
  outcome_delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  CONSTRAINT "tool_approvals_parameters_size"
    CHECK (pg_column_size(parameters) <= 16384),
  CONSTRAINT "tool_approvals_consumed_has_timestamp"
    CHECK (status <> 'consumed' OR consumed_at IS NOT NULL),
  CONSTRAINT "tool_approvals_conversation_fk"
    FOREIGN KEY (conversation_id, user_id)
    REFERENCES public.conversations (id, user_id)
    ON DELETE SET NULL (conversation_id)
);

CREATE INDEX IF NOT EXISTS "tool_approvals_user_status_idx"
  ON public.tool_approvals (user_id, status);

-- One open approval per conversation (ARCHITECTURE.md §5.8): a second
-- proposal while one is open is refused by the database itself, so an
-- injected prompt can never flood the owner with approval dialogs.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_one_open_approval"
  ON public.tool_approvals (conversation_id)
  WHERE status IN ('pending', 'approved');

ALTER TABLE public.tool_approvals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tool_approvals_owner_select" ON public.tool_approvals;
CREATE POLICY "tool_approvals_owner_select" ON public.tool_approvals
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- action_logs (DATABASE.md §3.9): the audit trail. Claim failures are
-- stored as not_executed rows with a reason (and a tamper flag) inside
-- result_payload. The approval foreign key is ON DELETE NO ACTION: it
-- still blocks a direct delete of an approval that has logs, but it is
-- checked at the end of the statement, so deleting a user account (which
-- cascades through both tables) is not blocked.
CREATE TABLE IF NOT EXISTS public.action_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid()
    REFERENCES auth.users (id) ON DELETE CASCADE,
  conversation_id uuid,
  approval_id uuid,
  tool_call_id text NOT NULL,
  tool_name text NOT NULL,
  parameters jsonb NOT NULL,
  execution_status text NOT NULL
    CHECK (execution_status IN ('pending', 'succeeded', 'failed', 'unknown', 'not_executed')),
  result_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "action_logs_result_size"
    CHECK (result_payload IS NULL OR pg_column_size(result_payload) <= 32768),
  CONSTRAINT "action_logs_conversation_fk"
    FOREIGN KEY (conversation_id, user_id)
    REFERENCES public.conversations (id, user_id)
    ON DELETE SET NULL (conversation_id),
  CONSTRAINT "action_logs_approval_fk"
    FOREIGN KEY (approval_id, user_id)
    REFERENCES public.tool_approvals (id, user_id)
    ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS "action_logs_user_id_idx"
  ON public.action_logs (user_id);

ALTER TABLE public.action_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "action_logs_owner_select" ON public.action_logs;
CREATE POLICY "action_logs_owner_select" ON public.action_logs
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Explicit grants (DATABASE.md §4): revoke the broad Supabase defaults,
-- then grant exactly what each table needs. The security tables are
-- SELECT-only for clients; writes go through the M3 functions.
REVOKE ALL ON public.memories, public.tool_approvals, public.action_logs
  FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memories TO authenticated;
GRANT SELECT ON public.tool_approvals, public.action_logs TO authenticated;

-- Stop future objects from regressing to broad defaults.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
