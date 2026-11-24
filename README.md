# FLASH

FLASH is a private, single-user personal AI assistant: a Next.js web app that chats (text and voice), keeps only memories the owner explicitly approves, manages tasks and notes, and runs a small set of registered tools only after the owner approves. It never claims an action succeeded unless the database confirms it.

Built from spec: `TASKS.md` is the ordered task list; `docs/` holds the PRD, tech stack, architecture, database, and design documents. The app is named FLASH throughout.

## Status

See `PROGRESS.md` for the current milestone, gate evidence, and session log.

## Local setup

Requires Node.js 24.x (see `.nvmrc`).

```sh
npm install
cp .env.example .env.local   # fill in real values; never commit .env.local
npm run dev
```

## Commands

- Dev server: `npm run dev`
- Production build: `npm run build`
- Lint: `npm run lint`
- Type check: `npx tsc --noEmit`
- Tests: `npm run test`
- Types: `npm run gen:types`
- Bundle check: `scripts/check-bundle.sh`

## Tests

- Run the full suite with `npm run test`. It sets `APP_ENV=dev`; running Vitest directly without that flag is refused by `tests/setup.ts` — the suite only ever runs against a local in-process PGlite database, never a live or production project. It also refuses if `NEXT_PUBLIC_SUPABASE_URL` points at a live Supabase project (any `*.supabase.co` URL).
- Database tests live in `tests/db/` with helpers in `tests/db/helpers.ts`: each test file starts a fresh PGlite database, applies all migrations, and creates/deletes its test users through the admin-API helpers (`createTestUser` / `deleteTestUser`, which insert into the `auth.users` stand-in — there is no live dev project in this build).
- After changing migrations, regenerate types with `npm run gen:types` (see "Database workflow" below).

## Health check

- `GET /api/health` needs a signed-in user (401 logged out) and returns `{ status: "online" | "limit_reached", usage, cap }`. It reads today's usage from `api_usage` and never calls the model, so it costs no quota. The top-bar status chip polls it.
- The daily cap is 20 model calls (PRD §6 [DECIDED]), overridable with `DAILY_MODEL_CALL_CAP` (see `lib/config.ts`); a bad override fails closed to 0.
- After a production build, run `scripts/check-bundle.sh`: it fails if a secret key shape (`sb_secret_…`, `AIza…`), a secret variable name, or a literal secret value from `.env.local` appears in the client bundle (`.next/static`). The service-role key lives only on the server via `utils/supabase/admin.ts` (`import "server-only"`).

## Demo script (M3 — the v0.1 demo)

Needs a live deployment with a model key (not in this build — see PROGRESS.md M3-28 for the code-evidence basis).

1. Ask FLASH to create a task ("Remind me to buy servo horns tomorrow"). The chat shows the exact action — tool, title, due date — in the approval dialog, with the risk badge and a countdown.
2. Approve. The task is created; it appears on the Overview Tasks panel and the Tasks screen.
3. Open Activity: the log shows the real result (succeeded, with the task id), never a claim.
4. Refresh the page: the task is still there, from the database.
5. Ask FLASH what tasks are pending: it retrieves them with the read-only `get_tasks` tool.

Negative checks (all covered by tests; see PROGRESS.md M3-28): reject an approval; alter the stored parameters (`hash_mismatch`); let an approval expire; replay an approval; fire five parallel executions (exactly one succeeds); exhaust retries; propose a second action while one is open; save a memory without approval (never saved) and flip memory off (nothing is injected).

## Database workflow

Migrations live in `supabase/migrations/` (one per task, plain-language header each). Create one with `npx supabase migration new <name>` (the Supabase CLI is a devDependency; it is never linked to a remote project in this build). SQL is validated locally with PGlite: `npm run test` applies the migrations to a fresh in-process database (PGlite 0.3.9) and runs the checks; database tests run with `APP_ENV=dev`. After changing migrations, regenerate types with `npm run gen:types` (writes `types/supabase.ts` from the migration-validated schema — see `scripts/gen-types.mjs`; no remote project needed) and commit the result. No remote Supabase project is created by this build; if the owner creates one later, migrations go there at milestone gates only (`supabase db push`, with the owner's confirmation, then relink to dev in the same session), then types are regenerated and committed. Never put a database password on the command line or in any file.

## Secret Rotation Rule

If a secret is ever committed, deleting it from history is not enough. Rotate it: (1) revoke the key at the provider, (2) create a new key, (3) update `.env.local` and Vercel.

## Security model (short version)

- The service-role key (`SUPABASE_SECRET_KEY`) is used only inside the `server-only` admin client (`utils/supabase/admin.ts`) and only to call the service-role functions listed in `docs/ARCHITECTURE.md` Section 4. Never prefix it `NEXT_PUBLIC_`.
- Every Route Handler and Server Action calls `getUser()` itself. The proxy is not authorization.
- The browser sends only an approval ID to approve, reject, execute, or resume. It never sends parameters, outcomes, or chat history.
- Model output, documents, and web content are untrusted data.
- Every model call passes the Model Gate (depth check, then `reserve_api_call`). Refund only when the server aborts before dispatch.
