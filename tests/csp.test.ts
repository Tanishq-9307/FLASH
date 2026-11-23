// M1-2, M3-25: CSP header builder (ARCHITECTURE.md §8). Enforced since
// M3-25 — the builder's output is set as `Content-Security-Policy` (not
// report-only) by proxy.ts.
import { describe, expect, it } from "vitest";
import { buildCsp } from "@/lib/security/csp";

describe("M1-2: buildCsp", () => {
  it("puts the per-request nonce in script-src", () => {
    const header = buildCsp("abc-123");
    expect(header).toContain("script-src 'self' 'nonce-abc-123'");
  });

  it("adds unsafe-eval in development only", () => {
    expect(buildCsp("n", { isDev: true })).toContain("'unsafe-eval'");
    expect(buildCsp("n", { isDev: false })).not.toContain("unsafe-eval");
    expect(buildCsp("n")).not.toContain("unsafe-eval");
  });

  it("includes the Supabase URL in connect-src when given", () => {
    const header = buildCsp("n", {
      supabaseUrl: "https://example.supabase.co",
    });
    expect(header).toContain("connect-src 'self' https://example.supabase.co");
    expect(buildCsp("n")).toContain("connect-src 'self'");
  });

  it("locks down frames and plugins", () => {
    const header = buildCsp("n");
    expect(header).toContain("frame-ancestors 'none'");
    expect(header).toContain("object-src 'none'");
    expect(header).toContain("base-uri 'self'");
  });

  it("blocks remote images (the hostile-markdown second layer)", () => {
    // Remote images are never rendered by the markdown component; the
    // CSP is the second layer that would block one anyway.
    expect(buildCsp("n")).toContain("img-src 'self' data: blob:");
    expect(buildCsp("n")).not.toContain("img-src 'self' data: blob: http");
  });
});
