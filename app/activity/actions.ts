// Activity Server Action (M3-22, DESIGN.md §5.6).
// The browser's only path to the audit log. Every action calls
// getUser() first; the rows are filtered by the caller's user_id and
// RLS allows SELECT only on action_logs, so a foreign id is
// indistinguishable from one that does not exist. The log is
// read-only: rows are never edited or deleted from here.
"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { createClient } from "@/utils/supabase/server";
import type { ActivityLogRow } from "@/lib/activity";

export type ActivityActionError = "unauthenticated" | "unavailable";

export type ActivityActionResult =
  | { ok: true; data: ActivityLogRow[] }
  | { ok: false; error: ActivityActionError };

const COLUMNS =
  "id, tool_name, parameters, execution_status, result_payload, created_at, approval_id, conversation_id";

/** Most rows the timeline ever loads. */
export const ACTIVITY_LIMIT = 100;

async function getUserId(
  supabase: SupabaseClient<Database>,
): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export async function listActivity(): Promise<ActivityActionResult> {
  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("action_logs")
    .select(COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(ACTIVITY_LIMIT);
  if (error || !data) return { ok: false, error: "unavailable" };
  return { ok: true, data: data as ActivityLogRow[] };
}
