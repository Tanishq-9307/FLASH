// Memory Server Actions (M3-23, DESIGN.md §5.1, DATABASE.md §3.7).
// The browser's only path to viewing, editing, and deleting memories
// by hand, and to the global memory switch. Every action calls
// getUser() first; ownership is enforced twice — the query filters by
// the caller's user_id, and the RLS policies only ever return the
// caller's rows. Validation limits equal the database CHECKs
// (lib/memories.ts). A change is reported only after the server
// returns the committed row (DESIGN.md §9, rule 2).
//
// The switch (settings.memory_enabled) is upserted on the first
// change: a missing settings row means "on" (the column defaults to
// true), so no row is written until the owner flips it.
"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { createClient } from "@/utils/supabase/server";
import {
  memoryFactSchema,
  memoryIdSchema,
  type Memory,
} from "@/lib/memories";

export type MemoryActionError =
  | "unauthenticated"
  | "invalid"
  | "not_found"
  | "unavailable";

export type MemoryActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: MemoryActionError };

const COLUMNS = "id, fact, created_at, updated_at";

async function getUserId(
  supabase: SupabaseClient<Database>,
): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export async function listMemories(): Promise<MemoryActionResult<Memory[]>> {
  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("memories")
    .select(COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error || !data) return { ok: false, error: "unavailable" };
  return { ok: true, data };
}

export async function updateMemory(
  id: string,
  fact: string,
): Promise<MemoryActionResult<Memory>> {
  const parsedId = memoryIdSchema.safeParse(id);
  const parsedFact = memoryFactSchema.safeParse(fact);
  if (!parsedId.success || !parsedFact.success) {
    return { ok: false, error: "invalid" };
  }

  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("memories")
    .update({ fact: parsedFact.data })
    .eq("id", parsedId.data)
    .eq("user_id", userId)
    .select(COLUMNS)
    .single();
  if (error || !data) return { ok: false, error: "not_found" };
  return { ok: true, data };
}

export async function deleteMemory(id: string): Promise<MemoryActionResult<{ id: string }>> {
  const parsedId = memoryIdSchema.safeParse(id);
  if (!parsedId.success) return { ok: false, error: "invalid" };

  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("memories")
    .delete()
    .eq("id", parsedId.data)
    .eq("user_id", userId)
    .select("id");
  if (error) return { ok: false, error: "unavailable" };
  if (!data || data.length === 0) return { ok: false, error: "not_found" };
  return { ok: true, data: { id: parsedId.data } };
}

/** The global memory switch. A missing settings row means on, so
 * reading it returns true; writing it upserts the row. The chat
 * route reads this same row (lib/memory-injection.ts): off means
 * nothing is injected into the prompt. */
export async function getMemoryEnabled(): Promise<
  MemoryActionResult<boolean>
> {
  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("settings")
    .select("memory_enabled")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { ok: false, error: "unavailable" };
  return { ok: true, data: data?.memory_enabled ?? true };
}

export async function setMemoryEnabled(
  enabled: boolean,
): Promise<MemoryActionResult<boolean>> {
  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("settings")
    .upsert({ user_id: userId, memory_enabled: enabled })
    .select("memory_enabled")
    .single();
  if (error || !data) return { ok: false, error: "unavailable" };
  return { ok: true, data: data.memory_enabled };
}
