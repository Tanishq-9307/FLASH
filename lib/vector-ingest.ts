// Vector ingestion (vector memory RAG, 2026-11-25).
//
// Plain language: when a memory is saved or a document is extracted,
// this embeds the new text (input_type "document" — stored content
// being indexed) and writes the vectors into the database through the
// service-role save_* functions. Embedding is best-effort and never
// blocks the save itself: a missing key, a provider failure, or a
// database error is logged and the row simply stays unembedded — the
// owner still has the memory or the document, and retrieval falls
// back to keywords. Nothing here ever throws to its caller.
//
// Call sites (all best-effort, all after the row is committed):
//   - embedMemory: a memory just saved (approved tool execution) or
//     edited (Memory screen) — an edit changes the meaning, so the
//     old vector would point at the old fact and must be replaced.
//   - embedDocumentPages: a document just extracted (upload route),
//     one embedding per ready page.
//   - embedNewMemoryFromApproval: the approvals action after a
//     save_memory approval executes — it only knows the new memory's
//     id, so it reads the fact back first.
// Rows that never got embedded (key added later, provider was down)
// are covered by scripts/backfill-embeddings.mjs — never by a retry
// loop here, so a failing provider cannot slow down a save.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import {
  EMBEDDING_DIMENSIONS,
  embedDocuments,
  isEmbeddingsAvailable,
  MAX_EMBEDDING_BATCH,
  type EmbeddingsResult,
} from "@/lib/ai/embeddings";

/** What an ingestion attempt ended as. "unavailable" means no key
 * (or nothing to embed); "failed" means the provider or the database
 * refused — either way the row stays unembedded and usable. */
export type IngestStatus = "embedded" | "unavailable" | "failed";

/** Injectable document embedder for tests; defaults to the real
 * Voyage client. Substitutes only the network call — the
 * VOYAGE_API_KEY availability check still applies. */
export type DocumentEmbedder = (
  texts: string[],
) => Promise<EmbeddingsResult>;

export interface VectorIngestDeps {
  embed?: DocumentEmbedder;
}

/** Chunk an array into batches of at most `size` (backfill + page
 * embedding batching). Pure, so the backfill script reuses it. */
export function chunkTexts<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Embed one memory fact and store its vector. Returns "embedded"
 * only when the save_* call succeeded; anything else leaves the row
 * unembedded and is logged, never thrown.
 */
export async function embedMemory(
  admin: SupabaseClient<Database>,
  userId: string,
  memoryId: string,
  fact: string,
  deps: VectorIngestDeps = {},
): Promise<IngestStatus> {
  if (!isEmbeddingsAvailable()) return "unavailable";
  if (fact.trim() === "") return "unavailable";
  try {
    const embed = deps.embed ?? embedDocuments;
    const { embeddings, usage } = await embed([fact]);
    const embedding = embeddings[0];
    if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
      console.error("Memory embedding failed: provider returned a bad vector");
      return "failed";
    }
    console.error(
      `[embeddings] memory embedded (${usage.totalTokens} tokens)`,
    );
    const { error } = await admin.rpc("save_memory_embedding", {
      p_user_id: userId,
      p_memory_id: memoryId,
      p_embedding: embedding,
    });
    if (error !== null) {
      console.error("Memory embedding save failed", error);
      return "failed";
    }
    return "embedded";
  } catch (err) {
    console.error("Memory embedding failed", err);
    return "failed";
  }
}

/**
 * Embed a memory the approvals action just saved: the action knows
 * the new memory's id but not its fact, so the fact is read back
 * first (service role — the row was just written for this user).
 * The availability check runs before any read, so with no key this
 * costs no database call at all.
 */
export async function embedNewMemoryFromApproval(
  admin: SupabaseClient<Database>,
  userId: string,
  memoryId: string,
  deps: VectorIngestDeps = {},
): Promise<IngestStatus> {
  if (!isEmbeddingsAvailable()) return "unavailable";
  try {
    const { data, error } = await admin
      .from("memories")
      .select("fact")
      .eq("id", memoryId)
      .eq("user_id", userId)
      .single();
    if (error !== null || data === null) {
      console.error(
        "Memory embedding failed: saved memory could not be read back",
        error,
      );
      return "failed";
    }
    return embedMemory(admin, userId, memoryId, data.fact, deps);
  } catch (err) {
    console.error("Memory embedding failed", err);
    return "failed";
  }
}

/**
 * Embed every ready page of a just-extracted document and store the
 * vectors, one save per page. Pages with no text are skipped (there
 * is nothing to embed, and an empty vector would be meaningless).
 * A single page's failure is logged and skipped — the other pages
 * still get embedded, and the upload itself already succeeded.
 */
export async function embedDocumentPages(
  admin: SupabaseClient<Database>,
  userId: string,
  documentId: string,
  pages: Array<{ page: number; text: string }>,
  deps: VectorIngestDeps = {},
): Promise<IngestStatus> {
  if (!isEmbeddingsAvailable()) return "unavailable";
  const withText = pages.filter((p) => p.text.trim() !== "");
  if (withText.length === 0) return "unavailable";
  const embed = deps.embed ?? embedDocuments;
  let embedded = 0;
  let failed = 0;
  try {
    for (const batch of chunkTexts(withText, MAX_EMBEDDING_BATCH)) {
      let result: EmbeddingsResult;
      try {
        result = await embed(batch.map((p) => p.text));
      } catch (err) {
        console.error("Document page embedding failed", err);
        failed += batch.length;
        continue;
      }
      console.error(
        `[embeddings] ${batch.length} document page(s) embedded (${result.usage.totalTokens} tokens)`,
      );
      for (let i = 0; i < batch.length; i += 1) {
        const embedding = result.embeddings[i];
        if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
          console.error(
            "Document page embedding failed: provider returned a bad vector",
          );
          failed += 1;
          continue;
        }
        const { error } = await admin.rpc("save_document_page_embedding", {
          p_user_id: userId,
          p_document_id: documentId,
          p_page_number: batch[i].page,
          p_embedding: embedding,
        });
        if (error !== null) {
          console.error("Document page embedding save failed", error);
          failed += 1;
        } else {
          embedded += 1;
        }
      }
    }
  } catch (err) {
    console.error("Document page embedding failed", err);
    return "failed";
  }
  if (embedded === 0 && failed > 0) return "failed";
  return "embedded";
}
