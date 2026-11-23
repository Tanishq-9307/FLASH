// Read-only tool execution (M3-17): the get_tasks query.
//
// Plain language: this is the one read-only tool the model can call.
// It only reads the owner's own tasks, through the user-scoped
// client, so RLS proves ownership — another user's tasks look
// absent. It never writes anything, so it never needs an approval;
// the loop logs the call via log_read_only_action instead (see
// execute-tool-call.ts). The result is capped so one call cannot
// flood the prompt with the whole task list.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";

/** At most this many tasks come back in one get_tasks result. */
export const GET_TASKS_RESULT_LIMIT = 50;

export interface TaskRow {
  id: string;
  title: string;
  due_date: string | null;
  status: string;
}

/**
 * List the owner's tasks, optionally filtered by status. Throws on a
 * database error — the caller logs the failure and returns an honest
 * error result to the model instead of inventing tasks.
 */
export async function executeGetTasks(
  supabase: SupabaseClient<Database>,
  userId: string,
  args: { status?: "pending" | "completed" },
): Promise<{ tasks: TaskRow[] }> {
  const query = supabase
    .from("tasks")
    .select("id, title, due_date, status")
    .eq("user_id", userId);
  const filtered =
    args.status !== undefined
      ? query.eq("status", args.status)
      : query;
  const { data, error } = await filtered
    .order("created_at", { ascending: true })
    .limit(GET_TASKS_RESULT_LIMIT);
  if (error || !data) {
    throw new Error(
      `Task list failed: ${error?.message ?? "no data returned"}`,
    );
  }
  return { tasks: data as TaskRow[] };
}
