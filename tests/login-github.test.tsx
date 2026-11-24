// @vitest-environment jsdom
// GitHub sign-in button tests (owner requirement 2026-11-24): the button
// renders, calls signInWithOAuth with provider "github", and shows a
// generic error on failure. The email/password form stays in place.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockSignInWithOAuth = vi.fn();

vi.mock("@/utils/supabase/client", () => ({
  createClient: vi.fn(() => ({
    auth: { signInWithOAuth: mockSignInWithOAuth },
  })),
}));

// The page's email/password form is a Server Action; it is not under
// test here, so it is stubbed rather than executed.
vi.mock("@/app/login/actions", () => ({
  signIn: vi.fn(),
}));

import LoginPage from "@/app/login/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GitHub sign-in button", () => {
  it("renders alongside the email/password form", () => {
    render(<LoginPage />);
    expect(
      screen.getByRole("button", { name: /continue with github/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^sign in$/i }),
    ).toBeInTheDocument();
  });

  it("calls signInWithOAuth with provider github and the callback URL", async () => {
    mockSignInWithOAuth.mockResolvedValue({
      data: { url: "https://github.com/login/oauth/authorize?x=1" },
      error: null,
    });
    render(<LoginPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /continue with github/i }),
    );
    expect(mockSignInWithOAuth).toHaveBeenCalledWith({
      provider: "github",
      options: { redirectTo: "http://localhost:3000/auth/callback" },
    });
    // On success Supabase redirects the browser away; the button stays
    // in its pending state while that happens.
    expect(
      await screen.findByRole("button", { name: /redirecting to github/i }),
    ).toBeInTheDocument();
  });

  it("shows a generic error on failure and never exposes provider details", async () => {
    mockSignInWithOAuth.mockResolvedValue({
      data: null,
      error: { message: "provider is not enabled" },
    });
    render(<LoginPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /continue with github/i }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("GitHub sign-in failed. Try again.");
    expect(alert).not.toHaveTextContent("provider is not enabled");
    // The button is usable again after a failure.
    expect(
      screen.getByRole("button", { name: /continue with github/i }),
    ).not.toBeDisabled();
  });
});
