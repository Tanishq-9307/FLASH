// Login screen (M1-1, DESIGN.md §5.1 screen 8). Email + password only.
// Single-user system: no sign-up link exists. Errors from the Server Action
// are generic by design.
"use client";

import { useActionState } from "react";
import { signIn, type SignInState } from "./actions";

export default function LoginPage() {
  const [state, formAction, isPending] = useActionState<SignInState, FormData>(
    signIn,
    {},
  );

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
