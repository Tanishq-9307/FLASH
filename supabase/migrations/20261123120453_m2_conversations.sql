-- M2-1: conversations table (TASKS.md M2-1, DATABASE.md §3.3, §4).
--
-- Plain language: this migration creates the table that holds one row per
-- chat conversation. Each row belongs to exactly one user (`user_id`
-- defaults to the signed-in user and is deleted with the account), has a
-- title the server sets from the first message, and carries `created_at` /
-- `updated_at` timestamps kept fresh by the shared `set_updated_at`
-- trigger from M1-3. The `UNIQUE (id, user_id)` constraint looks redundant
-- next to the primary key, but it is what lets child tables (messages, and
-- later approvals and logs) reference a conversation by (id, user_id) as a
-- pair — that pair is what stops a row from ever being attached to another
-- user's conversation. Row Level Security is on, with owner-only policies
-- for SELECT, INSERT, UPDATE and DELETE, and explicit grants: `anon` and
-- `authenticated` get exactly what §4 lists, nothing more. The delete
-- guard that refuses deletion while an approval is open comes in M3 (it
-- needs the `tool_approvals` table). Safe to run twice: IF NOT EXISTS,
-- DROP POLICY IF EXISTS, idempotent REVOKE/GRANT.

-- conversations (DATABASE.md §3.3): one row per chat conversation.
CREATE TABLE IF NOT EXISTS public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid()
    REFERENCES auth.users (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) <= 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "conversations_owner_select" ON public.conversations;
CREATE POLICY "conversations_owner_select" ON public.conversations
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "conversations_owner_insert" ON public.conversations;
CREATE POLICY "conversations_owner_insert" ON public.conversations
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "conversations_owner_update" ON public.conversations;
CREATE POLICY "conversations_owner_update" ON public.conversations
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "conversations_owner_delete" ON public.conversations;
CREATE POLICY "conversations_owner_delete" ON public.conversations
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Keep updated_at fresh on every update (helper from M1-3).
DROP TRIGGER IF EXISTS conversations_set_updated_at ON public.conversations;
CREATE TRIGGER conversations_set_updated_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Explicit grants (DATABASE.md §4).
REVOKE ALL ON public.conversations FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversations TO authenticated;

-- Stop future objects from regressing to broad defaults.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
