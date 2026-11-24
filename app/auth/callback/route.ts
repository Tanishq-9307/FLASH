// OAuth callback route (GitHub sign-in, owner requirement 2026-11-24).
// Follows the official @supabase/ssr guide: exchange the `code` the
// provider returns for a session, then redirect into the app. Without
// this route the "Continue with GitHub" button cannot complete sign-in.
// The proxy exempts this path from its logged-out redirect to /login,
// and a failure here redirects to /login with no provider details —
// never an error page that leaks them.
import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // Only same-origin relative paths are honoured, so a crafted
      // `next` cannot bounce the user to another site.
      const redirectTo =
        next.startsWith("/") && !next.startsWith("//") ? next : "/";
      return NextResponse.redirect(`${origin}${redirectTo}`);
    }
  }
  return NextResponse.redirect(`${origin}/login`);
}
