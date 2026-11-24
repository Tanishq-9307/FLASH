// Note Server Actions (M2-8b, DESIGN.md §5.1, DATABASE.md §3.6).
// The browser's only path to managing notes and searching them. Every
// action calls getUser() first; ownership is enforced twice — the query
// filters by the caller's user_id, and the RLS policies only ever
// return the caller's rows, so a foreign id is indistinguishable from
// one that does not exist. Validation limits equal the database CHECKs
// (lib/notes.ts). Errors are generic: the caller is never told whether
// a note exists or who owns it.
//
// Search uses the same expression as the GIN index: the `search`
// column is GENERATED ALWAYS AS to_tsvector('english', title || ' '
// || content), and textSearch with config "english" and type
// "websearch" queries it with websearch_to_tsquery('english', ...),
// so the index is used instead of the app loading every note and
// filtering in memory.
"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { createClient } from "@/utils/supabase/server";
import {
  NOTES_LIMIT,
  noteIdSchema,
  noteInputSchema,
  noteSearchSchema,
  type Note,
  type NoteInput,
} from "@/lib/notes";

export type NoteActionError =
  | "unauthenticated"
  | "invalid"
  | "not_found"
  | "unavailable";

export type NoteActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: NoteActionError };

const COLUMNS = "id, title, content, created_at, updated_at";

async function getUserId(
  supabase: SupabaseClient<Database>,
): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export async function listNotes(): Promise<NoteActionResult<Note[]>> {
  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("notes")
    .select(COLUMNS)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(NOTES_LIMIT);
  if (error || !data) return { ok: false, error: "unavailable" };
  return { ok: true, data };
}

export async function searchNotes(
  query: string,
): Promise<NoteActionResult<Note[]>> {
  const parsed = noteSearchSchema.safeParse(query);
  if (!parsed.success) return { ok: false, error: "invalid" };

  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("notes")
    .select(COLUMNS)
    .eq("user_id", userId)
    .textSearch("search", parsed.data, { config: "english", type: "websearch" })
    .order("updated_at", { ascending: false })
    .limit(NOTES_LIMIT);
  if (error || !data) return { ok: false, error: "unavailable" };
  return { ok: true, data };
}

export async function createNote(
  input: NoteInput,
): Promise<NoteActionResult<Note>> {
  const parsed = noteInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };

  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("notes")
    .insert({
      title: parsed.data.title,
      content: parsed.data.content,
      user_id: userId,
    })
    .select(COLUMNS)
    .single();
  if (error || !data) return { ok: false, error: "unavailable" };
  return { ok: true, data };
}

export async function editNote(
  noteId: string,
  input: NoteInput,
): Promise<NoteActionResult<Note>> {
  const id = noteIdSchema.safeParse(noteId);
  const parsed = noteInputSchema.safeParse(input);
  if (!id.success || !parsed.success) return { ok: false, error: "invalid" };

  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("notes")
    .update({ title: parsed.data.title, content: parsed.data.content })
    .eq("id", id.data)
    .eq("user_id", userId)
    .select(COLUMNS)
    .single();
  if (error || !data) return { ok: false, error: "not_found" };
  return { ok: true, data };
}

export async function deleteNote(
  noteId: string,
): Promise<NoteActionResult<{ id: string }>> {
  const id = noteIdSchema.safeParse(noteId);
  if (!id.success) return { ok: false, error: "invalid" };

  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("notes")
    .delete()
    .eq("id", id.data)
    .eq("user_id", userId)
    .select("id");
  if (error) return { ok: false, error: "unavailable" };
  if (!data || data.length === 0) return { ok: false, error: "not_found" };
  return { ok: true, data: { id: id.data } };
}
