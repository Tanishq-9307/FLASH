// OAuth callback route tests (GitHub sign-in, owner requirement
// 2026-11-24): the code is exchanged for a session and the user is
// redirected into the app; failures and missing codes go to /login,
// and a crafted `next` can never bounce the user to another site.
import { afterEach, describe, expect, it, vi } from "vitest";

const mockExchange = vi.fn();

vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { exchangeCodeForSession: mockExchange },
  })),
}));

import { GET } from "@/app/auth/callback/route";

afterEach(() => {
  vi.clearAllMocks();
});

async function get(url: string) {
  return GET(new Request(url));
}

describe("GET /auth/callback", () => {
  it("exchanges the code and redirects to the app root", async () => {
    mockExchange.mockResolvedValue({ data: {}, error: null });
    const res = await get("http://localhost:3000/auth/callback?code=abc123");
    expect(mockExchange).toHaveBeenCalledWith("abc123");
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
  });

  it("honours a same-origin next path", async () => {
    mockExchange.mockResolvedValue({ data: {}, error: null });
    const res = await get(
      "http://localhost:3000/auth/callback?code=abc123&next=/tasks",
    );
    expect(res.headers.get("location")).toBe("http://localhost:3000/tasks");
  });

  it("ignores an absolute next URL and redirects to the app root", async () => {
    mockExchange.mockResolvedValue({ data: {}, error: null });
    const res = await get(
      "http://localhost:3000/auth/callback?code=abc123&next=https://evil.example.com/",
    );
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
  });

  it("redirects to /login when the exchange fails", async () => {
    mockExchange.mockResolvedValue({
      data: null,
      error: { message: "bad code" },
    });
    const res = await get("http://localhost:3000/auth/callback?code=bad");
    expect(res.headers.get("location")).toBe("http://localhost:3000/login");
  });

  it("redirects to /login with no code and never calls the exchange", async () => {
    const res = await get("http://localhost:3000/auth/callback");
    expect(mockExchange).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("http://localhost:3000/login");
  });
});
