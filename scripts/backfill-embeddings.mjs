#!/usr/bin/env node
// backfill-embeddings.mjs — embed every memory and document page that
// has no embedding yet (vector memory RAG, 2026-11-25).
//
// Why this exists: rows saved before VOYAGE_API_KEY was configured —
// or saved while the provider was down — stay unembedded, and chat
// falls back to keywords for them. This script closes that gap. It is
// a MANUAL step, run by the owner (or an agent on the owner's word)
// from a machine with the keys — never by the app, never in CI, and
// never against the live database from this build environment.
//
// Usage (all three keys set in the environment — values are never
// written in this file or on the command line):
//   node scripts/backfill-embeddings.mjs
//
// What it does:
//   1. Reads memories with embedding IS NULL and document_pages with
//      embedding IS NULL (via the service-role key, through PostgREST).
//   2. Embeds them in batches of 128 (input_type "document") with
//      Voyage voyage-4-lite, output_dimension 512.
//   3. Writes each vector back through the service-role RPCs
//      save_memory_embedding / save_document_page_embedding.
//   4. Prints a per-batch summary (embedded / failed / tokens) and
//      exits non-zero if anything failed, so a rerun picks up exactly
//      the rows that are still unembedded (idempotent — rerunning is
//      safe and only processes rows that are still NULL).
//
// Cost (honest numbers): the first 200M Voyage tokens per account are
// free (voyage-4-lite, 2026-11-25). A memory is tens of tokens, a
// document page hundreds — a whole single-user corpus is thousands of
// tokens, i.e. effectively free. The script prints the provider's own
// total_tokens per batch so the real cost is visible; it keeps no
// meter of its own.
//
// Safety: refuses to run unless all three env vars are set. It only
// ever writes embedding columns, never text, statuses, or anything
// else. It never deletes anything.
//
// Self-contained on purpose: this script runs under plain `node`
// (no TS loader), so it must not import the app's TypeScript. The
// batching helper below is a 6-line duplicate of chunkTexts in
// lib/vector-ingest.ts — deliberately, so each side stays runnable
// on its own.
import { pathToFileURL } from "node:url";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const VOYAGE_KEY = process.env.VOYAGE_API_KEY;

const EMBEDDING_MODEL = "voyage-4-lite";
const EMBEDDING_DIMENSIONS = 512;
const BATCH_SIZE = 128;

/** Split an array into batches of at most `size`. Exported so tests
 * can check the batching without running a backfill. */
export function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function fail(message) {
  console.error(`backfill-embeddings: ${message}`);
  process.exit(1);
}

async function supabaseRpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    throw new Error(`${fn} returned HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function supabaseSelect(table, select, filters) {
  const params = new URLSearchParams({ select, ...filters });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`${table} select returned HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function embedBatch(texts) {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VOYAGE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: texts,
      model: EMBEDDING_MODEL,
      input_type: "document",
      output_dimension: EMBEDDING_DIMENSIONS,
      truncation: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`Voyage returned HTTP ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  if (
    !Array.isArray(body.data) ||
    body.data.length !== texts.length ||
    typeof body.usage?.total_tokens !== "number"
  ) {
    throw new Error("Voyage returned an unexpected response shape.");
  }
  return {
    embeddings: body.data.map((d) => d.embedding),
    totalTokens: body.usage.total_tokens,
  };
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY || !VOYAGE_KEY) {
    fail(
      "NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and VOYAGE_API_KEY must all be set.",
    );
  }
  const memories = await supabaseSelect("memories", "id,user_id,fact", {
    "embedding": "is.null",
  });
  const pages = await supabaseSelect(
    "document_pages",
    "document_id,user_id,page_number,content",
    { "embedding": "is.null" },
  );
  console.log(
    `backfill-embeddings: ${memories.length} memories, ${pages.length} document pages to embed.`,
  );
  let embedded = 0;
  let failed = 0;
  let tokens = 0;

  for (const batch of chunkArray(
    memories.filter((m) => m.fact.trim() !== ""),
    BATCH_SIZE,
  )) {
    try {
      const { embeddings, totalTokens } = await embedBatch(
        batch.map((m) => m.fact),
      );
      tokens += totalTokens;
      for (let i = 0; i < batch.length; i += 1) {
        try {
          await supabaseRpc("save_memory_embedding", {
            p_user_id: batch[i].user_id,
            p_memory_id: batch[i].id,
            p_embedding: embeddings[i],
          });
          embedded += 1;
        } catch (err) {
          failed += 1;
          console.error(`memory ${batch[i].id}: ${err.message}`);
        }
      }
      console.log(
        `memories batch: ${batch.length} embedded attempt(s), ${embedded} total embedded, ${failed} total failed, ${tokens} tokens so far.`,
      );
    } catch (err) {
      failed += batch.length;
      console.error(`memories batch failed: ${err.message}`);
    }
  }

  for (const batch of chunkArray(
    pages.filter((p) => p.content.trim() !== ""),
    BATCH_SIZE,
  )) {
    try {
      const { embeddings, totalTokens } = await embedBatch(
        batch.map((p) => p.content),
      );
      tokens += totalTokens;
      for (let i = 0; i < batch.length; i += 1) {
        try {
          await supabaseRpc("save_document_page_embedding", {
            p_user_id: batch[i].user_id,
            p_document_id: batch[i].document_id,
            p_page_number: batch[i].page_number,
            p_embedding: embeddings[i],
          });
          embedded += 1;
        } catch (err) {
          failed += 1;
          console.error(
            `page ${batch[i].document_id} p.${batch[i].page_number}: ${err.message}`,
          );
        }
      }
      console.log(
        `pages batch: ${batch.length} embedded attempt(s), ${embedded} total embedded, ${failed} total failed, ${tokens} tokens so far.`,
      );
    } catch (err) {
      failed += batch.length;
      console.error(`pages batch failed: ${err.message}`);
    }
  }

  console.log(
    `backfill-embeddings: done — ${embedded} embedded, ${failed} failed, ${tokens} Voyage tokens.`,
  );
  if (failed > 0) process.exit(1);
}

// Only run when executed directly (importing the file for its
// chunkArray export — e.g. from tests — must not start a backfill).
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
