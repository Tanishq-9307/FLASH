// Request-interception file (M1-2, M3-25). Next.js 16.4.1: the file is
// `proxy.ts` exporting a function named `proxy` (TECH_STACK.md §2). It
// refreshes the session (utils/supabase/middleware.ts), redirects
// unauthenticated users to /login, and sets the ENFORCED CSP header
// with a per-request nonce.
//
// The header goes on BOTH the request and the response: Next.js reads
// the nonce back out of the request headers' CSP value and applies it
// to its own scripts (see lib/security/csp.ts) — without the request
// copy, enforcement would block the framework's inline scripts and
// break hydration. The request headers are set before updateSession
// runs, so its NextResponse.next({ request }) carries them downstream.
// NOTE: this file is not an authorization layer (ARCHITECTURE.md §8).
// Every route and Server Action still calls getUser() itself; the proxy
// redirect is only a convenience that keeps logged-out users off protected
// pages. API routes are excluded by the matcher: they return their own
// 401 JSON instead of a redirect to an HTML page.
import { NextResponse, type NextRequest } from "next/server";
import { buildCsp } from "@/lib/security/csp";
import { updateSession } from "@/utils/supabase/middleware";

export async function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID();
  const csp = buildCsp(nonce, {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    isDev: process.env.NODE_ENV === "development",
  });
  // Request copy: Next.js extracts the nonce from here for its scripts.
  request.headers.set("Content-Security-Policy", csp);
  const { response, user } = await updateSession(request);
  const pathname = request.nextUrl.pathname;
  if (!user && pathname !== "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    const redirectResponse = NextResponse.redirect(url);
    redirectResponse.headers.set("Content-Security-Policy", csp);
    return redirectResponse;
  }
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("x-nonce", nonce);
  return response;
}

export const config = {
  matcher: [
    // Skip API routes (they return their own 401s) and static assets.
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
