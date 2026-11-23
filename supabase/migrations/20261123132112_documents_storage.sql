-- M5-1: documents, document_pages, private Storage bucket, save_document_extraction
-- (TASKS.md M5-1, DATABASE.md §3.10–3.12, §4, §5.1, §5.4, ARCHITECTURE.md §12).
--
-- Plain language: this migration creates the two tables that hold uploaded
-- PDFs and their extracted text. `documents` has one row per uploaded PDF:
-- the title, the file's path in Storage, its size, and a status that starts
-- at 'processing' and only ever moves to 'ready', 'no_text' or 'failed'
-- through the service-role function below — the browser can never set the
-- status itself, so it cannot claim a document was extracted when it was
-- not. `document_pages` holds the extracted text one row per page, with
-- the page number the citations point at; the browser can read pages but
-- never write them, so citation text always comes from the server's
-- extraction step. The Storage bucket `documents` is private: files are
-- never served by public URL, and the object policies only allow the owner
-- to read, upload, or delete files under their own folder — there is no
-- UPDATE policy, so an uploaded file cannot be swapped after its text was
-- extracted. The `storage_path` CHECK pins each row to its owner's file,
-- so a row can never point at somebody else's upload. `save_document_extraction`
-- is the only writer of pages and statuses: it refuses documents it does
-- not own or that are not still 'processing', validates the page list
-- (pages 1..n in order, at most 20,000 characters each), and writes the
-- pages and the status in one transaction. Safe to run twice: IF NOT
-- EXISTS, DROP POLICY IF EXISTS, CREATE OR REPLACE, ON CONFLICT DO NOTHING,
-- idempotent REVOKE/GRANT.

-- documents (DATABASE.md §3.10): one row per uploaded PDF.
CREATE TABLE IF NOT EXISTS public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid()
    REFERENCES auth.users (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 255),
  storage_path text NOT NULL UNIQUE
    CHECK (storage_path = user_id::text || '/' || id::text || '.pdf'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 4194304),
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'ready', 'no_text', 'failed')),
  page_count integer CHECK (page_count BETWEEN 1 AND 300),
  error_code text CHECK (char_length(error_code) <= 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "documents_owner_select" ON public.documents;
CREATE POLICY "documents_owner_select" ON public.documents
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- The WITH CHECK is the point: a client may only insert a row that is
-- still unprocessed, so it can never mark its own document as extracted.
DROP POLICY IF EXISTS "documents_owner_insert" ON public.documents;
CREATE POLICY "documents_owner_insert" ON public.documents
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid())
    AND status = 'processing'
    AND page_count IS NULL
    AND error_code IS NULL);

-- No UPDATE policy: status, page count and error are set only by
-- save_document_extraction below.
DROP POLICY IF EXISTS "documents_owner_delete" ON public.documents;
CREATE POLICY "documents_owner_delete" ON public.documents
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Keep updated_at fresh on every update (helper from M1-3).
DROP TRIGGER IF EXISTS documents_set_updated_at ON public.documents;
CREATE TRIGGER documents_set_updated_at
  BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- document_pages (DATABASE.md §3.11): extracted text, one row per page.
-- The search column is a generated tsvector so M5-4 retrieval is a
-- full-text query over the stored pages, not a scan of the app's memory.
CREATE TABLE IF NOT EXISTS public.document_pages (
  document_id uuid NOT NULL,
  user_id uuid NOT NULL DEFAULT auth.uid(),
  page_number integer NOT NULL CHECK (page_number BETWEEN 1 AND 300),
  content text NOT NULL CHECK (char_length(content) <= 20000),
  search tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  PRIMARY KEY (document_id, page_number),
  CONSTRAINT document_pages_document_fk
    FOREIGN KEY (document_id, user_id)
    REFERENCES public.documents (id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS document_pages_search_idx
  ON public.document_pages USING gin (search);

ALTER TABLE public.document_pages ENABLE ROW LEVEL SECURITY;

-- SELECT for the owner only. No client INSERT, UPDATE or DELETE: page text
-- is what citations point at, so only the server's extraction step writes
-- it, through save_document_extraction. Deleting the document deletes its
-- pages (ON DELETE CASCADE above).
DROP POLICY IF EXISTS "document_pages_owner_select" ON public.document_pages;
CREATE POLICY "document_pages_owner_select" ON public.document_pages
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Explicit grants (DATABASE.md §4).
REVOKE ALL ON public.documents, public.document_pages FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.documents TO authenticated;
GRANT SELECT ON public.document_pages TO authenticated;

-- Stop future objects from regressing to broad defaults.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- Private Storage bucket (DATABASE.md §3.12). The bucket row is created
-- here, in the migration, because this build has no dashboard step: on a
-- hosted project this INSERT is a no-op once the bucket exists.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('documents', 'documents', false, 4194304, '{application/pdf}')
ON CONFLICT (id) DO NOTHING;

-- Owner-folder policies on storage.objects. foldername(name)[1] is the
-- first path segment, which is the owner's user ID for our object names
-- (<user_id>/<document_id>.pdf). No UPDATE policy: an uploaded file cannot
-- be swapped after its text was extracted.
DROP POLICY IF EXISTS "documents_bucket_owner_select" ON storage.objects;
CREATE POLICY "documents_bucket_owner_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'documents'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

DROP POLICY IF EXISTS "documents_bucket_owner_insert" ON storage.objects;
CREATE POLICY "documents_bucket_owner_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'documents'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

DROP POLICY IF EXISTS "documents_bucket_owner_delete" ON storage.objects;
CREATE POLICY "documents_bucket_owner_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'documents'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

-- save_document_extraction (DATABASE.md §5.1): the only writer of page
-- rows and document statuses. Service role only; the server calls it with
-- the user ID from getUser() after extracting the PDF.
CREATE OR REPLACE FUNCTION public.save_document_extraction(
  p_user_id uuid,
  p_document_id uuid,
  p_status text,
  p_pages jsonb,
  p_error_code text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count int;
  v_page jsonb;
  v_n int;
BEGIN
  -- Only for a document owned by p_user_id that is still 'processing'.
  IF NOT EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.id = p_document_id
      AND d.user_id = p_user_id
      AND d.status = 'processing'
  ) THEN
    RAISE EXCEPTION 'save_document_extraction: document not found or not processing';
  END IF;
  IF p_status NOT IN ('ready', 'no_text', 'failed') THEN
    RAISE EXCEPTION 'save_document_extraction: invalid status %', p_status;
  END IF;
  IF p_status = 'ready' THEN
    IF p_pages IS NULL OR jsonb_typeof(p_pages) <> 'array' THEN
      RAISE EXCEPTION 'save_document_extraction: ready needs a pages array';
    END IF;
    v_count := jsonb_array_length(p_pages);
    IF v_count < 1 OR v_count > 300 THEN
      RAISE EXCEPTION 'save_document_extraction: ready needs 1..300 pages';
    END IF;
    FOR v_n IN 1..v_count LOOP
      v_page := p_pages -> (v_n - 1);
      IF (v_page ->> 'page') IS NULL
        OR (v_page ->> 'page')::int IS DISTINCT FROM v_n THEN
        RAISE EXCEPTION 'save_document_extraction: pages must be 1..n in order';
      END IF;
      IF (v_page ->> 'text') IS NULL
        OR char_length(v_page ->> 'text') > 20000 THEN
        RAISE EXCEPTION 'save_document_extraction: page text missing or too long';
      END IF;
    END LOOP;
    INSERT INTO public.document_pages (document_id, user_id, page_number, content)
      SELECT p_document_id, p_user_id,
        (p ->> 'page')::int, p ->> 'text'
      FROM jsonb_array_elements(p_pages) AS p;
    UPDATE public.documents
      SET status = 'ready', page_count = v_count,
        error_code = p_error_code, updated_at = now()
      WHERE id = p_document_id;
  ELSE
    -- 'no_text' and 'failed' store no pages. p_error_code records the
    -- reason ('page_truncated' is set by the server on 'ready' when a page
    -- was cut to 20,000 characters; see DATABASE.md §3.11).
    UPDATE public.documents
      SET status = p_status, error_code = p_error_code, updated_at = now()
      WHERE id = p_document_id;
  END IF;
END;
$$;

-- Only the service role may execute it (DATABASE.md §5.4).
REVOKE EXECUTE ON FUNCTION public.save_document_extraction(uuid, uuid, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_document_extraction(uuid, uuid, text, jsonb, text)
  TO service_role;
