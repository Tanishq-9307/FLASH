// Service-role Supabase client (M1-6). `server-only` makes any import of
// this module from a Client Component a build error, so the service-role key
// can never be bundled into client JavaScript.
//
// This client exists for exactly the service-role-only database functions
// listed in ARCHITECTURE.md §4.1 (reserve_api_call, refund_api_call,
// append_message, and the later M2/M3/M5/M6 functions) — never for reads
// the user's own session is allowed to make, and never for anything the
// browser calls directly. The key comes from SUPABASE_SECRET_KEY (server
// environment only, never a NEXT_PUBLIC_ variable).
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";

export function createAdminClient(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase admin client: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set.",
    );
  }
  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
