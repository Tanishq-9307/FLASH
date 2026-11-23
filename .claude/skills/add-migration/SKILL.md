---
name: add-migration
description: Writing and testing a Supabase migration for FLASH — one migration per task, plain-language header, RLS/policies/grants, SECURITY DEFINER functions, PGlite validation, type generation.
---

# add-migration

Use whenever a task creates or changes database objects. One migration per task (`TASKS.md` §0.1).

## 1. Create the migration

- Create it with the Supabase CLI: `npx supabase migration new <name>` (never hand-name the timestamp file). The file lives in `supabase/migrations/`.
- Start the file with a plain-language header explaining what it does and why.
- Follow `docs/DATABASE.md` for the exact shape: table definitions (§3), the grants block (§4), function contracts (§5).

## 2. Rules for every object

- **Tables:** RLS enabled. Policies `TO authenticated`, with `WITH CHECK` on writes. Owner-only by `user_id`.
- **Grants:** apply each table's grants in the migration that creates it. `REVOKE ALL ... FROM anon, authenticated` first, then the explicit `GRANT`s from `DATABASE.md` §4. Add the default-privilege revokes so future objects cannot regress to broad defaults.
- **Functions:** `SECURITY DEFINER` only where justified, always `SET search_path = public, pg_temp`. `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated`, then an explicit `GRANT` to exactly the roles in the `ARCHITECTURE.md` §4.4 matrix. Functions callable by `authenticated` take no user ID and use `auth.uid()`; service-role-only functions take `p_user_id` from the server's `getUser()`.
- **No dynamic SQL** built from stored parameters. Tool dispatch is a hardcoded branch per tool.
- **Transitions** are one conditional `UPDATE ... RETURNING`. Never a separate `SELECT` then `UPDATE`.
- Write migrations to be safe to run twice where the spec allows (`IF NOT EXISTS` / `CREATE OR REPLACE`), and say so in the header.

## 3. Validate with PGlite (no remote dev project in this build)

- Apply the migration to a fresh PGlite database, in timestamp order with all earlier migrations.
- PGlite has no Auth (`auth.users`, `auth.uid()`) and no Storage. Migrations and tests that touch them use local stand-ins (see `docs/TECH_STACK.md` §2.1): stub `auth.uid()` with a fixed test UUID and create the referenced `auth.users` row shape in the test schema, plus the three Supabase built-in roles (`anon`, `authenticated`, `service_role`, created `NOLOGIN` — the migrations' GRANT/REVOKE statements need them to exist). RLS policies and functions are validated as SQL; auth-dependent paths are verified against the real service when the owner connects one.
- Run the checks from `docs/DATABASE.md` §6 that apply to the change: isolation (user A sees none of user B's rows), privilege denials for `anon`/`authenticated` on service-role functions, cap/refund behaviour, atomic transitions under parallel calls, and the `updated_at` trigger.

## 4. Finish

- Regenerate types: `npm run gen:types` (writes `types/supabase.ts` from the migration-validated schema).
- Run the checkpoint routine (`new-task-session`): lint, type check, relevant tests, status in `TASKS.md`, one line in `PROGRESS.md`, commit with the task's message.
