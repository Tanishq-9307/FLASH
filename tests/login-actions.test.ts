// M1-1: signIn / signOut Server Actions.
// - Wrong password (or any auth error) returns the same generic message.
// - Success redirects to `/`; signOut signs out and redirects to `/login`.
// The Supabase server client and next/navigation are mocked; no network.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSignInWithPassword = vi.fn();
const mockSignOut = vi.fn();
const mockRedirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
const mockRevalidatePath = vi.fn();

vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      signInWithPassword: mockSignInWithPassword,
      signOut: mockSignOut,
    },
  })),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => mockRedirect(url),
}));

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));

import { signIn, signOut } from "@/app/login/actions";

function form(email: string, password: string): FormData {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("password", password);
  return fd;
}

describe("M1-1: signIn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wrong password returns the generic error and does not redirect", async () => {
    mockSignInWithPassword.mockResolvedValue({
      error: { message: "Invalid login credentials" },
    });
    const state = await signIn({}, form("tanishq.jshinde@gmail.com", "wrong"));
    expect(state).toEqual({ error: "Invalid login credentials." });
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("any other auth error is also the generic error (no detail leaks)", async () => {
    mockSignInWithPassword.mockResolvedValue({
      error: { message: "User not found in auth.users" },
    });
    const state = await signIn({}, form("nobody@example.com", "whatever"));
    expect(state).toEqual({ error: "Invalid login credentials." });
  });

  it("missing fields return the generic error without calling Supabase", async () => {
    const state = await signIn({}, form("", ""));
    expect(state).toEqual({ error: "Invalid login credentials." });
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });

  it("success revalidates and redirects to /", async () => {
    mockSignInWithPassword.mockResolvedValue({ error: null });
    await expect(signIn({}, form("tanishq.jshinde@gmail.com", "correct"))).rejects.toThrow(
      "REDIRECT:/",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});

describe("M1-1: signOut", () => {
  it("signs out and redirects to /login", async () => {
    mockSignOut.mockResolvedValue({ error: null });
    await expect(signOut()).rejects.toThrow("REDIRECT:/login");
    expect(mockSignOut).toHaveBeenCalled();
  });
});
