// Server Supabase client (M1-1). Follows the current official @supabase/ssr
// guide: createServerClient with getAll/setAll cookie handling. `cookies()`
// is async in Next.js 16. The try/catch in setAll is the documented
// pattern: Server Components cannot set cookies, and the proxy (M1-2)
// refreshes the session instead, so a set from that context is ignored
// rather than crashing the render.
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component: setting cookies is not
            // possible here; the proxy refreshes the session instead.
          }
        },
      },
    },
  );
}
