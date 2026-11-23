-- M2-4: append_message function (TASKS.md M2-4, DATABASE.md §5.1, §5.4,
-- ARCHITECTURE.md §4.4).
--
-- Plain language: this is the only way assistant and system messages get
-- into the database. The browser can never write them — the messages table
-- only lets a client insert plain user messages (M2-2) — so the server
-- calls this function with the service-role key after the model replies.
-- The function refuses any role other than 'assistant' or 'system': the
-- 'tool' role is written only by the approval functions (M3), because a
-- tool row is a claim that an action really happened, and only the
-- function that ran the action may make that claim. The composite foreign
-- key on messages enforces that the conversation belongs to the same user
-- the function was called for, so a message can never be filed under
-- somebody else's conversation. Only service_role may execute it; a client
-- calling it directly gets "permission denied". Safe to run twice: CREATE
-- OR REPLACE, idempotent REVOKE/GRANT.

-- append_message: the only way to write assistant and system messages.
CREATE OR REPLACE FUNCTION public.append_message(
  p_user_id uuid,
  p_conversation_id uuid,
  p_role text,
  p_content text,
  p_parts jsonb,
  p_tool_call_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_role NOT IN ('assistant', 'system') THEN
    RAISE EXCEPTION 'append_message: role must be assistant or system, got %', p_role;
  END IF;
  INSERT INTO public.messages (conversation_id, user_id, role, content, parts, tool_call_id)
  VALUES (p_conversation_id, p_user_id, p_role, p_content, p_parts, p_tool_call_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Only the service role may execute it (DATABASE.md §5.4). The server
-- calls it with the service-role key after the model replies; the browser
-- can never reach it.
REVOKE EXECUTE ON FUNCTION public.append_message(uuid, uuid, text, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_message(uuid, uuid, text, text, jsonb, text)
  TO service_role;
