// M1-2: CSP report-only header builder (ARCHITECTURE.md §8).
import { describe, expect, it } from "vitest";
import { buildCspReportOnly } from "@/lib/security/csp";

describe("M1-2: buildCspReportOnly", () => {
  it("puts the per-request nonce in script-src", () => {
    const header = buildCspReportOnly("abc-123");
    expect(header).toContain("script-src 'self' 'nonce-abc-123'");
  });

  it("adds unsafe-eval in development only", () => {
    expect(buildCspReportOnly("n", { isDev: true })).toContain("'unsafe-eval'");
    expect(buildCspReportOnly("n", { isDev: false })).not.toContain("unsafe-eval");
    expect(buildCspReportOnly("n")).not.toContain("unsafe-eval");
  });

  it("includes the Supabase URL in connect-src when given", () => {
    const header = buildCspReportOnly("n", {
      supabaseUrl: "https://example.supabase.co",
    });
    expect(header).toContain("connect-src 'self' https://example.supabase.co");
    expect(buildCspReportOnly("n")).toContain("connect-src 'self'");
  });

  it("locks down frames and plugins", () => {
    const header = buildCspReportOnly("n");
    expect(header).toContain("frame-ancestors 'none'");
    expect(header).toContain("object-src 'none'");
    expect(header).toContain("base-uri 'self'");
  });
});
