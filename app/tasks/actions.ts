// Task Server Actions (M2-8a, DESIGN.md §5.1, DATABASE.md §3.5).
// The browser's only path to managing tasks by hand. Every action calls
// getUser() first; ownership is enforced twice — the query filters by
// the caller's user_id, and the RLS policies only ever return the
// caller's rows, so a foreign id is indistinguishable from one that
// does not exist. Validation limits equal the database CHECKs
// (lib/tasks.ts). Errors are generic: the caller is never told whether
// a task exists or who owns it. A change is reported only after the
// server returns the committed row (DESIGN.md §9, rule 2).
"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { createClient } from "@/utils/supabase/server";
import {
  dueDayToTimestamp,
  sortTasks,
  taskIdSchema,
  taskInputSchema,
  taskStatusSchema,
  type Task,
  type TaskInput,
  type TaskStatus,
} from "@/lib/tasks";

export type TaskActionError =
  | "unauthenticated"
  | "invalid"
  | "not_found"
  | "unavailable";

export type TaskActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: TaskActionError };

const COLUMNS = "id, title, due_date, status, created_at, updated_at";

async function getUserId(
  supabase: SupabaseClient<Database>,
): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export async function listTasks(): Promise<TaskActionResult<Task[]>> {
  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("tasks")
    .select(COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error || !data) return { ok: false, error: "unavailable" };
  return { ok: true, data: sortTasks(data) };
}

export async function createTask(
  input: TaskInput,
): Promise<TaskActionResult<Task>> {
  const parsed = taskInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };

  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      title: parsed.data.title,
      due_date: dueDayToTimestamp(parsed.data.dueDay),
      user_id: userId,
    })
    .select(COLUMNS)
    .single();
  if (error || !data) return { ok: false, error: "unavailable" };
  return { ok: true, data };
}

export async function editTask(
  taskId: string,
  input: TaskInput,
): Promise<TaskActionResult<Task>> {
  const id = taskIdSchema.safeParse(taskId);
  const parsed = taskInputSchema.safeParse(input);
  if (!id.success || !parsed.success) return { ok: false, error: "invalid" };

  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("tasks")
    .update({
      title: parsed.data.title,
      due_date: dueDayToTimestamp(parsed.data.dueDay),
    })
    .eq("id", id.data)
    .eq("user_id", userId)
    .select(COLUMNS)
    .single();
  if (error || !data) return { ok: false, error: "not_found" };
  return { ok: true, data };
}

export async function setTaskStatus(
  taskId: string,
  status: TaskStatus,
): Promise<TaskActionResult<Task>> {
  const id = taskIdSchema.safeParse(taskId);
  const parsed = taskStatusSchema.safeParse(status);
  if (!id.success || !parsed.success) return { ok: false, error: "invalid" };

  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("tasks")
    .update({ status: parsed.data })
    .eq("id", id.data)
    .eq("user_id", userId)
    .select(COLUMNS)
    .single();
  if (error || !data) return { ok: false, error: "not_found" };
  return { ok: true, data };
}

export async function deleteTask(
  taskId: string,
): Promise<TaskActionResult<{ id: string }>> {
  const id = taskIdSchema.safeParse(taskId);
  if (!id.success) return { ok: false, error: "invalid" };

  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("tasks")
    .delete()
    .eq("id", id.data)
    .eq("user_id", userId)
    .select("id");
  if (error) return { ok: false, error: "unavailable" };
  if (!data || data.length === 0) return { ok: false, error: "not_found" };
  return { ok: true, data: { id: id.data } };
}
