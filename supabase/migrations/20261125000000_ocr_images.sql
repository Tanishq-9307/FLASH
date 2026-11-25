-- OCR for image uploads (owner-directed feature batch, 2026-11-25).
--
-- Plain language: until now the `documents` table and its Storage bucket
-- only accepted PDFs — the storage_path CHECK pinned every row to a
-- `.pdf` file and the bucket only allowed the PDF MIME type. Images
-- (PNG, JPEG, WebP) now go through the SAME documents pipeline as PDFs
-- (one `documents` row, extracted text in `document_pages`, same owner
-- rules), so this migration widens the two PDF-only gates and nothing
-- else: the storage_path CHECK accepts `.pdf`, `.png`, `.jpg`, `.jpeg`
-- or `.webp` after the document id, and the bucket's allowed MIME types
-- gain `image/png`, `image/jpeg` and `image/webp`. The 4 MB size limit,
-- the owner-folder path shape, the RLS policies, `save_document_extraction`
-- and the page-count / page-length CHECKs are all unchanged — an image is
-- stored as a single page (page 1) of OCR text, so every existing rule
-- still applies exactly as it did for PDFs. Safe to run twice: the old
-- CHECK is dropped only if it is still there (looked up by definition,
-- never by an assumed name), the new CHECK is added only if no
-- storage_path CHECK exists, and the bucket update is a plain UPDATE.

-- Widen the storage_path CHECK (DATABASE.md §3.10): the path is still
-- <user_id>/<document_id>.<ext>, but the extension may now be an image
-- type as well as .pdf.
DO $$
DECLARE
  v_con text;
BEGIN
  SELECT conname INTO v_con
  FROM pg_constraint
  WHERE conrelid = 'public.documents'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%storage_path%';
  IF v_con IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.documents DROP CONSTRAINT ' || quote_ident(v_con);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.documents'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%storage_path%'
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_storage_path_check
      CHECK (storage_path = user_id::text || '/' || id::text || '.pdf'
        OR storage_path = user_id::text || '/' || id::text || '.png'
        OR storage_path = user_id::text || '/' || id::text || '.jpg'
        OR storage_path = user_id::text || '/' || id::text || '.jpeg'
        OR storage_path = user_id::text || '/' || id::text || '.webp');
  END IF;
END $$;

-- Widen the bucket's allowed MIME types (DATABASE.md §3.12). The size
-- limit stays 4 MB and the bucket stays private.
UPDATE storage.buckets
  SET allowed_mime_types = '{application/pdf,image/png,image/jpeg,image/webp}'
  WHERE id = 'documents';
