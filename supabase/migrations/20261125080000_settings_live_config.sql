-- Live configuration panel (Phase 2, 2026-11-25): three new columns
-- on the existing per-user `settings` row. A missing row still means
-- "defaults", so no row is written until the owner changes a setting.
--
-- - `default_coding_mode`: the default model for new chats. Off means
--   the standard model (llama-3.3-70b-versatile); on means the larger
--   coding model (openai/gpt-oss-120b). The per-session toggle in chat
--   still overrides it for that session, and the chat route only
--   consults this column when the request carries no flag.
-- - `reduce_motion`: when on, animations play as a single static frame
--   (the layout sets data-reduce-motion on <html>; app/globals.css
--   honours it the same way it honours prefers-reduced-motion).
-- - `show_usage_meter`: when off, the Usage & Limits panel on the
--   Overview is replaced by a short note pointing at Settings.
--
-- No new table, no new policies, no grant changes: the existing
-- owner-only SELECT/INSERT/UPDATE policies and grants on `settings`
-- already cover these columns, and there is deliberately no column
-- for any credential — secrets stay in environment variables only.
-- Safe to run twice (IF NOT EXISTS).
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS default_coding_mode boolean NOT NULL DEFAULT false;

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS reduce_motion boolean NOT NULL DEFAULT false;

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS show_usage_meter boolean NOT NULL DEFAULT true;
