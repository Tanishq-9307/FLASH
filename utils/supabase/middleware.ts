// Session refresh for the request-interception file (M1-2). Follows the
// current official @supabase/ssr proxy pattern: create the server client
// from the request cookies, call getUser() (which refreshes the session
// when the token is expired), and return the response the client wrote
// cookies to — never a fresh NextResponse, or the refreshed cookies are
// dropped. Nothing runs between creating the client and the auth call.
// This file only refreshes; the redirect decision lives in proxy.ts so the
// two concerns are tested separately.
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { response: supabaseResponse, user };
}
