-- Telegram integration (2026-11-25, Phase 3): proactive nudges.
--
-- Plain language: the proactive engine sends at most a few nudges a day
-- (overdue / due-today tasks, high model usage) over Telegram. Two things
-- are needed in the database:
--   - a per-user on/off switch for proactive nudges, on the existing
--     `settings` row (missing row = defaults, so nudges are on until the
--     owner turns them off with /stop in Telegram);
--   - `telegram_nudges`, one row per nudge ever sent, keyed by
--     (user_id, nudge_key). The key is what makes dedupe work: the
--     engine only sends a nudge whose key has no row yet, so the same
--     overdue task is never nudged twice. The row also records the exact
--     text sent, so the owner can see what was sent and when.
-- Both are service-role-only for writes: the bot server inserts nudge
-- rows; clients get SELECT on telegram_nudges (owner only) so the owner
-- can see them, and the settings switch is already owner-writable
-- (M1-3). Safe to run twice: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS,
-- DROP POLICY IF EXISTS, idempotent REVOKE/GRANT.

-- Proactive on/off switch (default on; /stop in Telegram turns it off,
-- /resume turns it back on).
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS telegram_proactive_enabled boolean NOT NULL DEFAULT true;

-- Sent-nudge record + dedupe key.
CREATE TABLE IF NOT EXISTS public.telegram_nudges (
  user_id uuid NOT NULL
    REFERENCES auth.users (id) ON DELETE CASCADE,
  nudge_key text NOT NULL,
  kind text NOT NULL,
  message text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, nudge_key)
);

ALTER TABLE public.telegram_nudges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "telegram_nudges_owner_select" ON public.telegram_nudges;
CREATE POLICY "telegram_nudges_owner_select" ON public.telegram_nudges
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- No INSERT/UPDATE/DELETE policy: only the service-role server writes
-- nudge rows (the bot records what it sent; a client must never be able
-- to forge a "sent" row and suppress a real nudge).

-- Explicit grants (DATABASE.md §4): revoke the broad Supabase defaults,
-- then grant exactly what each table needs.
REVOKE ALL ON public.telegram_nudges FROM anon, authenticated;
GRANT SELECT ON public.telegram_nudges TO authenticated;

-- Stop future objects from regressing to broad defaults.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
