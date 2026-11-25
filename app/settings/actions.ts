// Settings Server Actions (Phase 2, 2026-11-25): the live
// configuration panel's read/write path. Every action calls getUser()
// first; ownership is enforced twice — the query filters by the
// caller's user_id, and the RLS policies only ever return the
// caller's rows. A change is reported only after the server returns
// the committed row.
//
// The write path upserts the row on the first change and only the
// fields the caller sent: a missing row means "defaults", so no row
// is written until the owner flips a switch, and flipping one switch
// never resets the others. The patch is validated against
// settingsUpdateSchema first — any unknown key (including anything
// named like a credential) is rejected before any database call.
"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { createClient } from "@/utils/supabase/server";
import {
  settingsUpdateSchema,
  settingsWithDefaults,
  type AppSettings,
} from "@/lib/settings";

export type SettingsActionError =
  | "unauthenticated"
  | "invalid"
  | "unavailable";

export type SettingsActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: SettingsActionError };

const COLUMNS =
  "memory_enabled, telegram_proactive_enabled, default_coding_mode, reduce_motion, show_usage_meter";

async function getUserId(
  supabase: SupabaseClient<Database>,
): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

/** The owner's settings, or the defaults when no row exists yet. */
export async function getSettings(): Promise<
  SettingsActionResult<AppSettings>
> {
  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("settings")
    .select(COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { ok: false, error: "unavailable" };
  return { ok: true, data: settingsWithDefaults(data) };
}

/**
 * Change one or more settings. The patch is validated first (unknown
 * keys rejected); the committed row is returned, so the panel only
 * ever shows a state the database has.
 */
export async function updateSettings(
  patch: unknown,
): Promise<SettingsActionResult<AppSettings>> {
  const parsed = settingsUpdateSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, error: "invalid" };

  const supabase = await createClient();
  const userId = await getUserId(supabase);
  if (!userId) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("settings")
    .upsert({ user_id: userId, ...parsed.data })
    .select(COLUMNS)
    .single();
  if (error || !data) return { ok: false, error: "unavailable" };
  return { ok: true, data: settingsWithDefaults(data) };
}
