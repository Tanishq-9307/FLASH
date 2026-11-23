-- M2-2: messages table (TASKS.md M2-2, DATABASE.md §3.4, §4, §1 principle 6).
--
-- Plain language: this migration creates the table that holds every turn of
-- every conversation. Each message belongs to one conversation and one user,
-- and the pair (conversation_id, user_id) must match a real conversation
-- owned by the same user — that composite foreign key is what stops a
-- message from being filed under somebody else's conversation. Messages are
-- deleted only when their conversation is deleted (ON DELETE CASCADE); the
-- client has no delete privilege at all, so history cannot be edited or
-- trimmed from the browser.
--
-- The strict part is the INSERT policy, and it exists because the model
-- reads conversation history: if the browser could write assistant, system
-- or tool messages, it could forge a fake model reply, a fake system
-- instruction, or a fake tool result — and the model would then act on
-- invented history. So the client may insert only plain user messages
-- (role = 'user', no tool-call parts, no tool_call_id), and may never
-- UPDATE a message. Assistant and system messages are written only by the
-- server-side `append_message` function (M2-4); tool messages only by the
-- approval functions (M3). Safe to run twice: IF NOT EXISTS, DROP POLICY
-- IF EXISTS, idempotent REVOKE/GRANT.

-- messages (DATABASE.md §3.4): one row per chat turn.
CREATE TABLE IF NOT EXISTS public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL DEFAULT auth.uid()
    REFERENCES auth.users (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content text NOT NULL CHECK (char_length(content) <= 100000),
  parts jsonb,
  tool_call_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, user_id)
    REFERENCES public.conversations (id, user_id) ON DELETE CASCADE
);

-- History reads in conversation order.
CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
  ON public.messages (conversation_id, created_at);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- The client sees only its own messages.
DROP POLICY IF EXISTS "messages_owner_select" ON public.messages;
CREATE POLICY "messages_owner_select" ON public.messages
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- The client may insert ONLY plain user messages: no parts, no
-- tool_call_id, role exactly 'user'. Assistant, system and tool rows are
-- written server-side only (append_message, M2-4; approval functions, M3).
DROP POLICY IF EXISTS "messages_owner_insert_user_only" ON public.messages;
CREATE POLICY "messages_owner_insert_user_only" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND role = 'user'
    AND parts IS NULL
    AND tool_call_id IS NULL
  );

-- No UPDATE policy and no DELETE policy: messages are never edited, and
-- are removed only by the cascade when their conversation is deleted.

-- Explicit grants (DATABASE.md §4).
REVOKE ALL ON public.messages FROM anon, authenticated;
GRANT SELECT, INSERT ON public.messages TO authenticated;

-- Stop future objects from regressing to broad defaults.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
