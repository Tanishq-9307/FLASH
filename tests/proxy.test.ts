// M1-2: proxy — session refresh, unauthenticated redirect, CSP header.
// The Supabase client is mocked (no network): getUser() returns null for a
// logged-out user and a user object when logged in.
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

  it("logged-out / redirects to /login with the CSP header", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await proxy(request("/"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/login");
    const csp = res.headers.get("Content-Security-Policy-Report-Only");
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("https://example.supabase.co");
  });

  it("logged-out /login is not redirected", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await proxy(request("/login"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toContain(
      "script-src 'self' 'nonce-",
    );
  });

  it("logged-in / passes through with the CSP header and an x-nonce", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
      error: null,
    });
    const res = await proxy(request("/"));
    expect(res.status).toBe(200);
    const nonce = res.headers.get("x-nonce");
    expect(nonce).toBeTruthy();
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toContain(
      `'nonce-${nonce}'`,
    );
  });
});
