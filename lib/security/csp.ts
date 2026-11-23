// Content-Security-Policy (report-only) builder (M1-2, ARCHITECTURE.md §8).
// Nonce-based; `unsafe-eval` is added to script-src in development only
// (Next.js dev tooling needs it); `connect-src` includes the Supabase
// project URL so the browser client can reach Auth. The policy is
// report-only in M1: it never blocks, it only reports. It is switched to
// enforced before the M3 gate, after violations are reviewed.
// The nonce is generated per request in proxy.ts; this module only builds
// the header value, so it is a pure function and directly testable.
export function buildCspReportOnly(
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
