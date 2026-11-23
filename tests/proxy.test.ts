// M1-2, M3-25: proxy — session refresh, unauthenticated redirect, CSP header.
// The Supabase client is mocked (no network): getUser() returns null for a
// logged-out user and a user object when logged in.
// Since M3-25 the policy is ENFORCED: the response carries
// `Content-Security-Policy` (never the report-only header), and the same
// header is set on the request headers so Next.js can read the nonce back
// out for its own scripts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockGetUser, mockCreateServerClient } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockCreateServerClient: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: mockCreateServerClient,
}));

import { proxy } from "@/proxy";

function request(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`);
}

describe("M1-2: proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    mockCreateServerClient.mockReturnValue({
      auth: { getUser: mockGetUser },
    });
  });

  it("logged-out / redirects to /login with the enforced CSP header", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const req = request("/");
    const res = await proxy(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/login");
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("https://example.supabase.co");
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
    // The request copy carries the same header, so Next.js can read
    // the nonce for its own scripts.
    expect(req.headers.get("Content-Security-Policy")).toBe(csp);
  });

  it("logged-out /login is not redirected", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await proxy(request("/login"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "script-src 'self' 'nonce-",
    );
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
  });

  it("logged-in / passes through with the enforced CSP header and an x-nonce", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
      error: null,
    });
    const req = request("/");
    const res = await proxy(req);
    expect(res.status).toBe(200);
    const nonce = res.headers.get("x-nonce");
    expect(nonce).toBeTruthy();
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toContain(`'nonce-${nonce}'`);
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
    expect(req.headers.get("Content-Security-Policy")).toBe(csp);
  });
});
