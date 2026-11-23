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

## Database workflow

Migrations live in `supabase/migrations/` (one per task, plain-language header each). SQL is validated locally with PGlite; database tests run against PGlite with `APP_ENV=dev`. No remote Supabase project is created by this build; if the owner creates one later, migrations go there at milestone gates only, then types are regenerated and committed.

## Secret Rotation Rule

If a secret is ever committed, deleting it from history is not enough. Rotate it: (1) revoke the key at the provider, (2) create a new key, (3) update `.env.local` and Vercel.

## Security model (short version)

- The service-role key (`SUPABASE_SECRET_KEY`) is used only inside the `server-only` admin client (`utils/supabase/admin.ts`) and only to call the service-role functions listed in `docs/ARCHITECTURE.md` Section 4. Never prefix it `NEXT_PUBLIC_`.
- Every Route Handler and Server Action calls `getUser()` itself. The proxy is not authorization.
- The browser sends only an approval ID to approve, reject, execute, or resume. It never sends parameters, outcomes, or chat history.
- Model output, documents, and web content are untrusted data.
- Every model call passes the Model Gate (depth check, then `reserve_api_call`). Refund only when the server aborts before dispatch.
