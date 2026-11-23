-- M2-3: tasks and notes tables (TASKS.md M2-3, DATABASE.md §3.5, §3.6, §4).
--
-- Plain language: this migration creates the two tables the Tasks & Notes
-- screen works with. `tasks` holds a title, an optional due date, and a
-- status that is either pending or completed (the database refuses any
-- other value). `notes` holds a title and a body, plus a `search` column
-- that Postgres fills in itself from the title and body — it is a
-- GENERATED column, so nobody can write it by hand, and it always matches
-- the text it indexes. A GIN full-text index sits on that column, so
-- searching notes is a database index lookup instead of the app loading
-- every note and filtering in JavaScript. Both tables get the shared
-- `set_updated_at` trigger, owner-only policies for SELECT, INSERT, UPDATE
-- and DELETE, and explicit grants (authenticated gets exactly what §4
-- lists; anon gets nothing). Safe to run twice: IF NOT EXISTS, DROP POLICY
-- IF EXISTS, idempotent REVOKE/GRANT.

-- tasks (DATABASE.md §3.5).
CREATE TABLE IF NOT EXISTS public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid()
    REFERENCES auth.users (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) <= 255),
  due_date timestamptz,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);

CREATE INDEX IF NOT EXISTS tasks_user_status_idx
  ON public.tasks (user_id, status);

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tasks_owner_select" ON public.tasks;
CREATE POLICY "tasks_owner_select" ON public.tasks
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "tasks_owner_insert" ON public.tasks;
CREATE POLICY "tasks_owner_insert" ON public.tasks
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "tasks_owner_update" ON public.tasks;
CREATE POLICY "tasks_owner_update" ON public.tasks
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "tasks_owner_delete" ON public.tasks;
CREATE POLICY "tasks_owner_delete" ON public.tasks
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP TRIGGER IF EXISTS tasks_set_updated_at ON public.tasks;
CREATE TRIGGER tasks_set_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

REVOKE ALL ON public.tasks FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO authenticated;

-- notes (DATABASE.md §3.6).
CREATE TABLE IF NOT EXISTS public.notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid()
    REFERENCES auth.users (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) <= 255),
  content text NOT NULL CHECK (char_length(content) <= 100000),
  search tsvector GENERATED ALWAYS AS
    (to_tsvector('english', title || ' ' || content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);

CREATE INDEX IF NOT EXISTS notes_search_idx
  ON public.notes USING GIN (search);

ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notes_owner_select" ON public.notes;
CREATE POLICY "notes_owner_select" ON public.notes
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "notes_owner_insert" ON public.notes;
CREATE POLICY "notes_owner_insert" ON public.notes
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "notes_owner_update" ON public.notes;
CREATE POLICY "notes_owner_update" ON public.notes
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "notes_owner_delete" ON public.notes;
CREATE POLICY "notes_owner_delete" ON public.notes
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP TRIGGER IF EXISTS notes_set_updated_at ON public.notes;
CREATE TRIGGER notes_set_updated_at
  BEFORE UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

REVOKE ALL ON public.notes FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notes TO authenticated;

-- Stop future objects from regressing to broad defaults.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
