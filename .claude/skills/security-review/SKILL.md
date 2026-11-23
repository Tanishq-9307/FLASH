---
name: security-review
description: The structured FLASH security review — function grants, approval flow, ownership, secrets, error handling, logs, rate cap, bundle check; findings with severity, recorded in PROGRESS.md.
---

# security-review

Use at the review tasks (`TASKS.md` M3 review, wrap-up W-2) and before any milestone gate. `docs/ARCHITECTURE.md` and `docs/DATABASE.md` are the specification; code is judged against them.

## Checklist

Verify each item against the real code and the real database, not from memory.

1. **Function grants (`ARCHITECTURE.md` §4.3–§4.4, `DATABASE.md` §5.4).** Every function has `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` followed by an explicit `GRANT` to exactly the matrix roles. `SECURITY DEFINER` only where justified, always `SET search_path = public, pg_temp`. Authenticated functions take no user ID (`auth.uid()`); service-role functions take `p_user_id` from the server's `getUser()`.
2. **Tables and RLS (`DATABASE.md` §4, §6).** RLS enabled on every table in `public`. Policies `TO authenticated` with `WITH CHECK` on writes. `anon` holds no table privileges. Default privileges revoked for future objects. Client INSERT/UPDATE on `tool_approvals`, `action_logs`, `api_usage` is blocked.
3. **Approval flow (`ARCHITECTURE.md` §5).** Transitions are single conditional `UPDATE ... RETURNING` statements. Parameters immutable and hashed by Postgres at creation and execution. One open approval per conversation (partial unique index). Dispatch is a hardcoded branch per tool; no SQL built from stored parameters. Every final state writes a tool message. Expiry is lazy (`now() > expires_at`); no cron.
4. **Ownership.** Every read/write path is scoped to the authenticated user. The browser never sends a user ID, parameters, outcomes, or chat history for approval actions (approval ID only, from M2 on).
5. **Secrets.** No secret in the repo, in logs, or in the client bundle. Service-role key only inside the `server-only` admin client (`utils/supabase/admin.ts`) and only for the allowlisted functions (`ARCHITECTURE.md` §4.5). No `NEXT_PUBLIC_` prefix on any server secret. Run `scripts/check-bundle.sh` on a production build and confirm it passes. Confirm the pre-commit/pre-push hooks still block a runtime-generated fake key.
6. **Error handling and logging (`ARCHITECTURE.md` §10).** No stack traces or secrets in client-facing errors. Logs are redacted. Generic error messages on auth failures.
7. **Rate cap and Model Gate (`ARCHITECTURE.md` §6).** Every model call passes the gate (depth ≤ 3, `reserve_api_call` before dispatch, refund only when the server aborts before dispatch). Cap values come from server configuration only.
8. **Output rendering and CSP (`ARCHITECTURE.md` §8).** Markdown with no raw HTML and no remote images; links show their domain and use `rel="noopener noreferrer"`. CSP nonce-based and enforced before M3 closes.
9. **Untrusted content (`ARCHITECTURE.md` §9).** Model output, documents, and web content are treated as data, never as instructions.

## Reporting

- List findings with severity (critical / high / medium / low), the file and line, and the spec section violated.
- Fix each finding, or consciously accept it with a stated reason. Record the decision in `PROGRESS.md`.
- **Distinguish tested protections from unverified assumptions.** A check that was run and passed is evidence; a check that could not run (for example, one needing the live service) is an open assumption, listed as such.
