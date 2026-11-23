// Browser Supabase client (M1-1). Follows the current official @supabase/ssr
// guide: createBrowserClient with the publishable (browser-safe) key only.
// Used by Client Components. Never holds the secret key.
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
