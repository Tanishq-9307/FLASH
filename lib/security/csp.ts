// Content-Security-Policy builder (M1-2, M3-25, ARCHITECTURE.md §8).
// Nonce-based; `unsafe-eval` is added to script-src in development only
// (Next.js dev tooling needs it); `connect-src` includes the Supabase
// project URL so the browser client can reach Auth.
//
// Enforced since M3-25 (was report-only in M1): the proxy sets this
// header as `Content-Security-Policy` on the response AND on the
// request headers, so Next.js itself can read the nonce back out of
// the request (it parses `script-src` for a 'nonce-…' source and
// applies it to its own scripts — without that step, enforcement
// would block the framework's inline scripts and break hydration).
// The nonce is generated per request in proxy.ts; this module only
// builds the header value, so it is a pure function and directly
// testable.
export function buildCsp(
  nonce: string,
  opts: { supabaseUrl?: string; isDev?: boolean } = {},
): string {
  const scriptSrc = ["'self'", `'nonce-${nonce}'`];
  if (opts.isDev) scriptSrc.push("'unsafe-eval'");
  const connectSrc = ["'self'"];
  if (opts.supabaseUrl) connectSrc.push(opts.supabaseUrl);
  if (opts.isDev) connectSrc.push("ws:");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
