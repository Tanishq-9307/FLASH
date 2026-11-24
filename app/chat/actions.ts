// Conversation Server Actions (M2-7, DESIGN.md §5.1).
// The browser's only path to listing, renaming, and deleting
// conversations. Every action calls getUser() first; ownership is
// enforced twice — the query filters by the caller's user_id, and the
// RLS policies (DATABASE.md §3.3) only ever return the caller's rows,
// so a foreign id is indistinguishable from one that does not exist.
// Errors are generic: the caller is never told whether a conversation
// exists or who owns it.
//
// Delete and the M3 guard: deleting a conversation with an open
// (pending or approved, unexpired) approval is refused by the database
// trigger (M3-1b, error conversation_has_open_approval). The action
// maps that refusal to the "open_approval" code so the UI can tell the
// owner to cancel the pending action first instead of showing a
// generic failure.
"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { createClient } from "@/utils/supabase/server";
import {
  conversationIdSchema,
  conversationTitleSchema,
  type ConversationSummary,
} from "@/lib/conversations";

export type ConversationActionError =
  | "unauthenticated"
  | "invalid"
  | "not_found"
  | "unavailable"
  | "open_approval";

export type ConversationActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ConversationActionError };

const LIST_COLUMNS = "id, title, updated_at";

async function getUserId(
  supabase: SupabaseClient<Database>,
): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export async function listConversations(): Promise<
  ConversationActionResult<ConversationSummary[]>
> {
  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("conversations")
    .select(LIST_COLUMNS)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error || !data) return { ok: false, error: "unavailable" };
  return { ok: true, data };
}

export async function renameConversation(
  conversationId: string,
  title: string,
): Promise<ConversationActionResult<ConversationSummary>> {
  const id = conversationIdSchema.safeParse(conversationId);
  const cleanTitle = conversationTitleSchema.safeParse(title);
  if (!id.success || !cleanTitle.success) {
    return { ok: false, error: "invalid" };
  }

  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("conversations")
    .update({ title: cleanTitle.data })
    .eq("id", id.data)
    .eq("user_id", userId)
    .select(LIST_COLUMNS)
    .single();
  // No row matched: the id is missing or belongs to someone else —
  // the caller cannot tell which, and neither can the error.
  if (error || !data) return { ok: false, error: "not_found" };
  return { ok: true, data };
}

export async function deleteConversation(
  conversationId: string,
): Promise<ConversationActionResult<{ id: string }>> {
  const id = conversationIdSchema.safeParse(conversationId);
  if (!id.success) return { ok: false, error: "invalid" };

  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("conversations")
    .delete()
    .eq("id", id.data)
    .eq("user_id", userId)
    .select("id");
  if (error) {
    if (error.message.includes("conversation_has_open_approval")) {
      return { ok: false, error: "open_approval" };
    }
    return { ok: false, error: "unavailable" };
  }
  if (!data || data.length === 0) {
    return { ok: false, error: "not_found" };
  }
  return { ok: true, data: { id: id.data } };
}
