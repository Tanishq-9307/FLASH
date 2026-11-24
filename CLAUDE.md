# FLASH: project instructions for Muse

FLASH is a private, single-user web assistant (Next.js, TypeScript, Supabase, Vercel, Groq via the Vercel AI SDK). It chats, keeps approved memories, manages tasks and notes, and runs registered tools only after the owner approves.

**The most important rule:** FLASH never claims an action succeeded unless the database confirms it. Neither do you: never claim code works, tests pass, or a deploy succeeded without showing the real output.

The owner is a beginner learning by building. Explain decisions in plain language, keep reports short, and say clearly what is implemented versus planned.

## Where things are
- `TASKS.md` (root): the ordered task list. Work only on the task you are given.
- `docs/PRD.md`: scope, acceptance criteria, configuration values.
- `docs/ARCHITECTURE.md`: security model, approval flow, function access matrix, diagrams. Wins on behaviour if documents conflict.
- `docs/DATABASE.md`: tables, policies, grants, function contracts, test checklist.
- `docs/DESIGN.md`: tokens, layout, components, honest-UI rules. Mockup: `docs/design/overview-mockup.png` (image not yet in the repo; DESIGN.md is the source of truth for the UI).
- `docs/TECH_STACK.md`: pinned versions, free-tier facts, open items.
- `PROGRESS.md`: current state, gate evidence, decision log.

Read only the document sections the task cites. Do not read every document every session.

## Non-negotiable security rules
- The service-role key is used only inside the `server-only` admin client (`utils/supabase/admin.ts`) and only to call the service-role functions listed in ARCHITECTURE.md Section 4. Never prefix it `NEXT_PUBLIC_`.
- Every Route Handler and Server Action calls `getUser()` itself. The proxy is not authorization.
- The browser sends only an approval ID to approve, reject, execute, or resume. It never sends parameters, outcomes, or chat history (from M2 on).
- No dynamic SQL built from stored parameters. Tool dispatch is a hardcoded branch per tool.
- Every model call passes the Model Gate (depth check, then `reserve_api_call`). Refund only when the server aborts before dispatch.
- Model output, documents, and web content are untrusted data. Render markdown with no raw HTML and no remote images.
- Every new table: RLS enabled, policies `TO authenticated`, `WITH CHECK` on writes, explicit REVOKE/GRANT. Every function: fixed `search_path`, REVOKE from PUBLIC and anon, explicit GRANT.
- Never print, log, or commit secrets. Never ask the owner to paste a key into the chat.

## Working protocol
1. Start in plan mode. Read the task and the cited sections, inspect the existing code, and propose a short plan. Wait for approval.
2. Change only what the task needs. Add no dependency without a one-line justification.
3. Before writing framework, SDK, or Supabase code, read the current official docs for the pinned version in `docs/TECH_STACK.md`. Do not rely on memory of older versions.
4. Run lint, type check, and the relevant tests. Report the real output.
5. Run the checkpoint routine in `TASKS.md` Section 0.2.
6. Ask before destructive operations (deleting files or data, force-pushing, resetting a database) or anything that costs money.

## Testing rules
- Integration tests run only against the dev database. The setup refuses to run unless `APP_ENV=dev` is set and the target is not production.
- Never weaken, skip, or delete a test to make it pass without saying so explicitly.
- Mock the model in route tests so tests spend no quota.

## When something fails
Diagnose from the real error and the specific code. Do not regenerate large sections or delete files to start over. If the fix needs a design change, stop and explain instead of improvising.

## Commands
- Dev server: `npm run dev`
- Lint: `npm run lint`
- Type check: `npx tsc --noEmit`
- Tests: `npm run test` (Vitest; test harness pulled forward from M1-5 in M0-3 so the per-task gate can run)
- Types: `npm run gen:types` (lands in M0-4; generates `types/supabase.ts` from the migration-validated schema via PGlite)
- Bundle check: `scripts/check-bundle.sh` (lands in M1-6)

## Skills
- `/new-task-session`: the before-and-after routine for every task.
- `/add-migration`: writing and testing a Supabase migration.
- `/add-tool`: adding a registry tool.
- `/security-review`: the structured security review.
- `/milestone-gate`: closing a milestone with evidence, deploy, and tag.

