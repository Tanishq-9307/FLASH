-- M1-3: configuration and quota tables (TASKS.md M1-3, DATABASE.md §3.1–3.2, §4).
--
-- Plain language: this migration creates the two tables the rate limiter
-- needs. `settings` holds per-user switches (today: whether memory is on);
-- a missing row means "defaults", so the app never has to create one at
-- signup. `api_usage` counts model calls per user per day (Asia/Kolkata
-- day); its composite primary key (user_id, usage_date) is what makes the
-- daily cap a single atomic upsert instead of a read-then-write. It also
-- creates the shared `set_updated_at` trigger helper the M2 tables use.
-- Both tables have Row Level Security on, owner-only policies, and explicit
-- grants: `anon` and `authenticated` get exactly what §4 lists, nothing
-- more. `api_usage` is SELECT-only for clients; only the service-role
-- functions (M1-4) write it. Safe to run twice: IF NOT EXISTS, DROP POLICY
-- IF EXISTS, CREATE OR REPLACE for the helper, idempotent REVOKE/GRANT.

-- Shared updated_at trigger helper (used by M2 tables).
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- settings (DATABASE.md §3.1): one row per user, missing row = defaults.
CREATE TABLE IF NOT EXISTS public.settings (
  user_id uuid PRIMARY KEY DEFAULT auth.uid()
    REFERENCES auth.users (id) ON DELETE CASCADE,
  memory_enabled boolean NOT NULL DEFAULT true
);

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "settings_owner_select" ON public.settings;
CREATE POLICY "settings_owner_select" ON public.settings
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "settings_owner_insert" ON public.settings;
CREATE POLICY "settings_owner_insert" ON public.settings
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "settings_owner_update" ON public.settings;
CREATE POLICY "settings_owner_update" ON public.settings
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- No DELETE policy: settings rows are never deleted by clients.

-- api_usage (DATABASE.md §3.2): daily model-call counts, SELECT-only.
CREATE TABLE IF NOT EXISTS public.api_usage (
  user_id uuid NOT NULL DEFAULT auth.uid()
    REFERENCES auth.users (id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  model_calls int NOT NULL DEFAULT 0 CHECK (model_calls >= 0),
  PRIMARY KEY (user_id, usage_date)
);

ALTER TABLE public.api_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "api_usage_owner_select" ON public.api_usage;
CREATE POLICY "api_usage_owner_select" ON public.api_usage
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Explicit grants (DATABASE.md §4): revoke the broad Supabase defaults,
-- then grant exactly what each table needs. Writes to api_usage go only
-- through the service-role functions (M1-4).
REVOKE ALL ON public.settings, public.api_usage FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.settings TO authenticated;
GRANT SELECT ON public.api_usage TO authenticated;

-- Stop future objects from regressing to broad defaults.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
