// Owner resolution for Telegram (Phase 3, 2026-11-25). The bot has no
// browser session, so the server must map "the owner" to a Supabase
// user id itself. This app serves exactly one account (M1-0), so the
// owner is found by email in the Auth admin user list. Returns null
// when the account cannot be found — the caller then sends nothing,
// never guesses a user id.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { TELEGRAM_OWNER_EMAIL } from "./config";

export async function resolveTelegramOwnerId(
  admin: SupabaseClient<Database>,
): Promise<string | null> {
  try {
    const { data, error } = await admin.auth.admin.listUsers();
    if (error) {
      console.error("Telegram: owner lookup failed", error);
      return null;
    }
    const owner = data.users.find(
      (u) => u.email === TELEGRAM_OWNER_EMAIL,
    );
    return owner?.id ?? null;
  } catch (err) {
    console.error("Telegram: owner lookup failed", err);
    return null;
  }
}
