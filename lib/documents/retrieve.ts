// Read-only document retrieval (M5-4): full-text search over the stored
// pages of one document.
//
// This is the read-only document tool's core: it only reads, it only sees
// the one document the user asked about, and it runs through the
// user-scoped client, so RLS proves ownership — another user's pages look
// absent. The caller passes the client in; the route passes its own
// user-scoped client. Registering this as a tool in the M3 tool loop (so
// the model can choose to call it) is pending for the M3 build — until
// then the chat route calls it directly when the request names a document.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";

export interface RetrievedPage {
  page_number: number;
  content: string;
}

/** At most this many pages enter the prompt for one question. */
export const DOCUMENT_RETRIEVAL_LIMIT = 5;

/**
 * Full-text search over `document_pages` for one document: the `search`
 * tsvector column (GIN-indexed, M5-1) filters by the query, results come
 * back in page order. Throws on a database error — the route fails closed
 * instead of answering from nothing.
 */
export async function searchDocumentPages(
  supabase: SupabaseClient<Database>,
  userId: string,
  documentId: string,
  query: string,
  limit: number = DOCUMENT_RETRIEVAL_LIMIT,
): Promise<RetrievedPage[]> {
  const { data, error } = await supabase
    .from("document_pages")
    .select("page_number, content")
    .eq("document_id", documentId)
    .eq("user_id", userId)
    .textSearch("search", query, { type: "plain", config: "english" })
    .order("page_number", { ascending: true })
    .limit(limit);
  if (error || !data) {
    throw new Error(
      `Document search failed: ${error?.message ?? "no data returned"}`,
    );
  }
  return data;
}
