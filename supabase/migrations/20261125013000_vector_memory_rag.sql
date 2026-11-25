-- Vector memory RAG (owner-directed feature batch, 2026-11-25).
--
-- Plain language: FLASH can now retrieve memories and document pages
-- by MEANING, not just by keywords or recency. Each memory fact and
-- each document page gets a 512-number embedding (a list of floats
-- that places the text in a meaning space, produced by Voyage AI's
-- voyage-4-lite model — see lib/ai/embeddings.ts). At chat time the
-- question is embedded the same way, and the two match_* functions
-- below return the rows whose embeddings point in the most similar
-- direction (cosine similarity), so the model sees the relevant facts
-- even when they share no words with the question. The existing
-- keyword / recency paths stay as the fallback: when there is no
-- embeddings key, when the provider fails, or when nothing is similar
-- enough, chat behaves exactly as before.
--
-- Why real[] and NOT pgvector (decision, 2026-11-25): hosted Supabase
-- supports pgvector (Dashboard -> Database -> Extensions -> "vector",
-- or CREATE EXTENSION vector), but the dev harness in this build is
-- PGlite, which does NOT ship pgvector — a vector(512) column would
-- make this migration unappliable locally, so the core functions
-- could not be tested at all. The alternative used here is a plain
-- real[] column plus a pure-SQL cosine-similarity function: no
-- extension, the migration applies identically on hosted Supabase and
-- on PGlite, and every function below is fully validated locally.
-- The trade-off is honest: there is no ANN index (HNSW/IVFFlat), so
-- matching is an exact scan. That is the right trade for a
-- single-user app whose corpus is tens of memories and hundreds of
-- document pages at most — an exact scan over that many rows is
-- milliseconds, and it is MORE accurate than approximate search. If
-- the corpus ever grows past ~10k embedded rows, switch the columns
-- to vector(512) with an HNSW index and rewrite cosine_similarity as
-- (1 - (a <=> b)); the RPC function names and the TypeScript call
-- sites do not need to change, only the column type and the internals.
--
-- Dimensions are pinned to 512 by CHECKs and by the save_* functions:
-- voyage-4-lite defaults to 1024, but FLASH asks for output_dimension
-- 512 (Matryoshka — see lib/ai/embeddings.ts), which halves storage
-- against 1024 and thirds it against OpenAI's 1536. A row whose
-- embedding is NULL is simply unembedded (no key yet, provider
-- failed, backfill pending) — retrieval skips it and falls back.
--
-- Safe to run twice: IF NOT EXISTS / CREATE OR REPLACE, idempotent
-- REVOKE/GRANT.

-- Embedding columns (DATABASE.md §3.7 memories, §3.11 document_pages).
-- NULL means "not embedded yet" — never a fake vector.
ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS embedding real[];

ALTER TABLE public.document_pages
  ADD COLUMN IF NOT EXISTS embedding real[];

-- Pin the dimension: an embedding is either NULL or exactly 512
-- numbers. array_length returns NULL for an empty array, so COALESCE
-- guards that case too (an empty array fails the check).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.memories'::regclass
      AND conname = 'memories_embedding_dim_check'
  ) THEN
    ALTER TABLE public.memories
      ADD CONSTRAINT memories_embedding_dim_check
      CHECK (embedding IS NULL OR COALESCE(array_length(embedding, 1), -1) = 512);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.document_pages'::regclass
      AND conname = 'document_pages_embedding_dim_check'
  ) THEN
    ALTER TABLE public.document_pages
      ADD CONSTRAINT document_pages_embedding_dim_check
      CHECK (embedding IS NULL OR COALESCE(array_length(embedding, 1), -1) = 512);
  END IF;
END $$;

-- Cosine similarity between two equal-length float arrays, in [-1, 1].
-- Returns NULL when either side is NULL, when the lengths differ, or
-- when either side is the zero vector (no direction to compare) — the
-- match functions filter NULLs out via the threshold comparison, so a
-- degenerate row can never be returned as a match. IMMUTABLE: the
-- result depends only on the inputs.
CREATE OR REPLACE FUNCTION public.cosine_similarity(a real[], b real[])
RETURNS double precision
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN a IS NULL OR b IS NULL THEN NULL
    WHEN array_length(a, 1) IS DISTINCT FROM array_length(b, 1) THEN NULL
    ELSE (
      SELECT CASE WHEN denom = 0 THEN NULL ELSE dot / denom END
      FROM (
        SELECT SUM(x * y) AS dot,
               sqrt(SUM(x * x)) * sqrt(SUM(y * y)) AS denom
        FROM unnest(a, b) AS t(x, y)
      ) s
    )
  END;
$$;

-- match_memories: the owner's memories most similar to a query
-- embedding, best first. Only rows that are actually embedded, only
-- this user, only at or above the threshold. match_count is clamped
-- to 1..20 so a caller cannot ask for the whole table.
CREATE OR REPLACE FUNCTION public.match_memories(
  p_user_id uuid,
  p_query_embedding real[],
  p_match_threshold double precision DEFAULT 0.5,
  p_match_count int DEFAULT 5
)
RETURNS TABLE(id uuid, fact text, similarity double precision)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT m.id, m.fact,
         public.cosine_similarity(m.embedding, p_query_embedding) AS similarity
  FROM public.memories m
  WHERE m.user_id = p_user_id
    AND m.embedding IS NOT NULL
    AND public.cosine_similarity(m.embedding, p_query_embedding)
        >= COALESCE(p_match_threshold, 0.5)
  ORDER BY similarity DESC, m.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_match_count, 5), 1), 20);
$$;

-- match_document_pages: the owner's document pages most similar to a
-- query embedding, best first, across ALL of the owner's ready
-- documents (not just one document — that is the RAG value: a
-- question can surface a passage from a document the owner did not
-- name). The document title rides along so the chat route can cite
-- where each passage came from. Only 'ready' documents: a page from
-- a failed or still-processing document must never be quoted.
CREATE OR REPLACE FUNCTION public.match_document_pages(
  p_user_id uuid,
  p_query_embedding real[],
  p_match_threshold double precision DEFAULT 0.5,
  p_match_count int DEFAULT 5
)
RETURNS TABLE(
  document_id uuid,
  document_title text,
  page_number int,
  content text,
  similarity double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.document_id, d.title, p.page_number, p.content,
         public.cosine_similarity(p.embedding, p_query_embedding) AS similarity
  FROM public.document_pages p
  JOIN public.documents d
    ON d.id = p.document_id AND d.user_id = p.user_id
  WHERE p.user_id = p_user_id
    AND p.embedding IS NOT NULL
    AND d.status = 'ready'
    AND public.cosine_similarity(p.embedding, p_query_embedding)
        >= COALESCE(p_match_threshold, 0.5)
  ORDER BY similarity DESC, p.document_id ASC, p.page_number ASC
  LIMIT LEAST(GREATEST(COALESCE(p_match_count, 5), 1), 20);
$$;

-- save_memory_embedding: the only writer of memories.embedding.
-- Service role only; the server calls it with the user ID from
-- getUser() after embedding the fact. Refuses a wrong-dimension
-- vector (the CHECK would refuse it too — this fails with a clear
-- message first) and a memory the user does not own.
CREATE OR REPLACE FUNCTION public.save_memory_embedding(
  p_user_id uuid,
  p_memory_id uuid,
  p_embedding real[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_embedding IS NULL
     OR COALESCE(array_length(p_embedding, 1), -1) <> 512 THEN
    RAISE EXCEPTION 'save_memory_embedding: embedding must be 512 numbers';
  END IF;
  UPDATE public.memories
  SET embedding = p_embedding
  WHERE id = p_memory_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'save_memory_embedding: memory not found';
  END IF;
END;
$$;

-- save_document_page_embedding: the only writer of
-- document_pages.embedding. Same rules as save_memory_embedding: the
-- page must exist and belong to the user, the vector must be 512
-- numbers. Called once per page after a successful extraction.
CREATE OR REPLACE FUNCTION public.save_document_page_embedding(
  p_user_id uuid,
  p_document_id uuid,
  p_page_number int,
  p_embedding real[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_embedding IS NULL
     OR COALESCE(array_length(p_embedding, 1), -1) <> 512 THEN
    RAISE EXCEPTION 'save_document_page_embedding: embedding must be 512 numbers';
  END IF;
  UPDATE public.document_pages
  SET embedding = p_embedding
  WHERE document_id = p_document_id
    AND user_id = p_user_id
    AND page_number = p_page_number;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'save_document_page_embedding: page not found';
  END IF;
END;
$$;

-- Only the service role may execute these (DATABASE.md §5.4). The
-- match functions take the user ID explicitly because SECURITY
-- DEFINER bypasses RLS — the WHERE clause is the isolation, exactly
-- as in save_document_extraction and record_api_call. cosine_similarity
-- is a pure helper: no role but service_role needs it directly, and
-- the SECURITY DEFINER match functions run as owner either way.
REVOKE EXECUTE ON FUNCTION public.cosine_similarity(real[], real[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cosine_similarity(real[], real[])
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.match_memories(uuid, real[], double precision, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_memories(uuid, real[], double precision, int)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.match_document_pages(uuid, real[], double precision, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_document_pages(uuid, real[], double precision, int)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.save_memory_embedding(uuid, uuid, real[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_memory_embedding(uuid, uuid, real[])
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.save_document_page_embedding(uuid, uuid, int, real[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_document_page_embedding(uuid, uuid, int, real[])
  TO service_role;
