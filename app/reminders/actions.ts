// Reminder Server Actions (Phase 3, 2026-11-25). The browser's
// only path to managing reminders by hand. Every action calls
// getUser() first; ownership is enforced twice — the query filters
// by the caller's user_id, and the RLS policies only ever return
// the caller's rows, so a foreign id is indistinguishable from one
// that does not exist. Validation limits equal the database CHECKs
// (lib/reminders/reminders.ts). Errors are generic: the caller is
// never told whether a reminder exists or who owns it. A change is
// reported only after the server returns the committed row
// (DESIGN.md §9, rule 2).
//
// A reminder is corrected by deleting it and creating a new one:
// there is no edit action, so a row's time can never silently
// change after the owner set it. Cancelling keeps the row (status
// 'cancelled') so the owner can see what was called off; deleting
// removes it.
"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { createClient } from "@/utils/supabase/server";
import {
  reminderIdSchema,
  reminderInputSchema,
  sortReminders,
  type Reminder,
  type ReminderInput,
} from "@/lib/reminders/reminders";

export type ReminderActionError =
  | "unauthenticated"
  | "invalid"
  | "not_found"
  | "unavailable";

export type ReminderActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ReminderActionError };

const COLUMNS =
  "id, user_id, message, remind_at, status, source, sent_at, created_at, updated_at";

async function getUserId(
  supabase: SupabaseClient<Database>,
): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export async function listReminders(): Promise<
  ReminderActionResult<Reminder[]>
> {
  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("reminders")
    .select(COLUMNS)
    .eq("user_id", userId)
    .order("remind_at", { ascending: true })
    .limit(500);
  if (error || !data) return { ok: false, error: "unavailable" };
  return { ok: true, data: sortReminders(data) };
}

export async function createReminder(
  input: ReminderInput,
): Promise<ReminderActionResult<Reminder>> {
  const parsed = reminderInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  // A reminder in the past would fire on the next cron run, so it
  // is refused here — the owner picks a future time instead.
  if (new Date(parsed.data.remindAt).getTime() <= Date.now()) {
    return { ok: false, error: "invalid" };
  }

  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("reminders")
    .insert({
      message: parsed.data.message,
      remind_at: parsed.data.remindAt,
      user_id: userId,
      source: "web",
    })
    .select(COLUMNS)
    .single();
  if (error || !data) return { ok: false, error: "unavailable" };
  return { ok: true, data };
}

export async function cancelReminder(
  reminderId: string,
): Promise<ReminderActionResult<Reminder>> {
  const id = reminderIdSchema.safeParse(reminderId);
  if (!id.success) return { ok: false, error: "invalid" };

  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("reminders")
    .update({ status: "cancelled" })
    .eq("id", id.data)
    .eq("user_id", userId)
    .eq("status", "pending")
    .select(COLUMNS)
    .single();
  if (error || !data) return { ok: false, error: "not_found" };
  return { ok: true, data };
}

export async function deleteReminder(
  reminderId: string,
): Promise<ReminderActionResult<{ id: string }>> {
  const id = reminderIdSchema.safeParse(reminderId);
  if (!id.success) return { ok: false, error: "invalid" };

  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("reminders")
    .delete()
    .eq("id", id.data)
    .eq("user_id", userId)
    .select("id");
  if (error) return { ok: false, error: "unavailable" };
  if (!data || data.length === 0) return { ok: false, error: "not_found" };
  return { ok: true, data: { id: id.data } };
}
