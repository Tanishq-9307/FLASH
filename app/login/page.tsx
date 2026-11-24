// Login screen (M1-1, DESIGN.md §5.1 screen 8). Email + password, plus
// "Continue with GitHub" (owner requirement 2026-11-24 — the Supabase
// GitHub provider is enabled in the flash project; the OAuth return lands
// on /auth/callback). Single-user system: no sign-up link exists. Errors
// from the Server Action are generic by design, and the GitHub error is
// generic too — provider details are never shown.
"use client";

import { useState } from "react";
import { useActionState } from "react";
import { signIn, type SignInState } from "./actions";
import { createClient } from "@/utils/supabase/client";

const GITHUB_ERROR = "GitHub sign-in failed. Try again.";

export default function LoginPage() {
  const [state, formAction, isPending] = useActionState<SignInState, FormData>(
    signIn,
    {},
  );
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubPending, setGithubPending] = useState(false);

  async function signInWithGitHub() {
    setGithubError(null);
    setGithubPending(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      // On success Supabase redirects the browser to GitHub, so this
      // only runs when the call itself fails.
      setGithubError(GITHUB_ERROR);
      setGithubPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="flash-frame w-full max-w-sm p-8">
        <h1 className="font-display text-3xl font-semibold tracking-wide text-text-primary">
          FLASH
        </h1>
        <p className="panel-title mt-2">Sign in</p>
        <p className="mt-4 text-sm text-text-secondary">
          Private assistant. One account, no public registration.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <button
            type="button"
            onClick={signInWithGitHub}
            disabled={githubPending}
            className="flex min-h-11 items-center justify-center gap-2 rounded-md border border-border-strong bg-surface px-4 py-2 text-base font-semibold text-text-primary disabled:opacity-50"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="currentColor"
            >
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
            {githubPending ? "Redirecting to GitHub…" : "Continue with GitHub"}
          </button>
          {githubError ? (
            <p role="alert" className="text-sm text-danger">
              {githubError}
            </p>
          ) : null}
        </div>
        <div
          aria-hidden="true"
          className="mt-6 flex items-center gap-3 text-xs text-text-muted"
        >
          <span className="h-px flex-1 bg-border-strong" />
          or
          <span className="h-px flex-1 bg-border-strong" />
        </div>
        <form action={formAction} className="mt-6 flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm text-text-secondary">
            Email
            <input
              type="email"
              name="email"
              autoComplete="email"
              required
              className="rounded-md border border-border-strong bg-surface px-3 py-2 text-base text-text-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-text-secondary">
            Password
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              className="rounded-md border border-border-strong bg-surface px-3 py-2 text-base text-text-primary"
            />
          </label>
          {state.error ? (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={isPending}
            className="rounded-md bg-accent-cyan px-4 py-2 text-base font-semibold text-on-accent disabled:opacity-50"
          >
            {isPending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
