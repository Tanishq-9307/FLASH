// Test-database helpers (M1-5).
//
// In this build there is no live dev Supabase project: the dev database is
// a fresh in-process PGlite instance per test file. The "admin API" of
// TASKS.md §0.3 is therefore simulated here: test users are created and
// deleted by inserting into / deleting from the `auth.users` stand-in table
// as the PGlite superuser. When a real dev project exists, swap
// createTestUser / deleteTestUser for supabaseAdmin.auth.admin.createUser /
// deleteUser and point createTestDb at that project — the test bodies below
// do not change.
//
// Two PGlite behaviours the harness works around (see PROGRESS.md M1-4):
// - `db.query()` with parameters is a prepared statement: one statement
//   only. SET ROLE and the function call must be separate queries.
// - In PGlite, service_role holds no table grants by default. On hosted
//   Supabase it holds broad table access, so createTestDb grants it ALL on
//   the public tables to mirror the hosted environment. The migration
//   itself stays spec-pure and grants service_role only EXECUTE on the
//   functions.
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The auth stand-ins mirror scripts/gen-types.mjs (kept in sync by hand;
// gen-types.mjs is the canonical copy used by the type generator).
// `auth.uid()` returns the UUID in the session setting
// `app.current_user_id` when set, else the zero UUID — so tests can act as
// different users via `setTestUser` (M2-5 isolation needs user A vs B;
// the M1 fixed-UUID stub could not express that).
const AUTH_STANDINS = `
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT COALESCE(NULLIF(current_setting('app.current_user_id', true), '')::uuid, '00000000-0000-0000-0000-000000000000'::uuid) $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;
`;

// Storage stand-ins (M5-1): minimal `storage.buckets` / `storage.objects`
// tables plus `storage.foldername()`, so the M5-1 migration's bucket insert
// and owner-folder object policies validate on PGlite. Mirrors
// scripts/gen-types.mjs; kept in sync by hand.
const STORAGE_STANDINS = `
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  owner uuid,
  public boolean NOT NULL DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text NOT NULL,
  name text NOT NULL,
  owner uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_accessed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE
  AS $$ SELECT string_to_array($1, '/') $$;
-- Hosted Supabase grants schema USAGE to the built-in roles; PGlite grants
-- nothing by default, so mirror the hosted grants.
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
-- Hosted Supabase grants the built-in roles table access on the storage
-- tables (the RLS policies decide what actually happens).
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
GRANT SELECT ON storage.buckets TO authenticated;
GRANT ALL ON storage.objects, storage.buckets TO service_role;
`;

/** Fresh in-process dev database: stand-ins, roles, all migrations applied. */
export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(AUTH_STANDINS);
  await db.exec(STORAGE_STANDINS);
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(dir, file), "utf8"));
  }
  // Hosted Supabase grants service_role broad table access; PGlite does not.
  await db.exec(`GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;`);
  return db;
}

/** Admin-API equivalent: create a test user in auth.users. */
export async function createTestUser(db: PGlite): Promise<string> {
  const id = randomUUID();
  await db.query("INSERT INTO auth.users (id) VALUES ($1)", [id]);
  return id;
}

/** Admin-API equivalent: delete a test user (ON DELETE CASCADE cleans up). */
export async function deleteTestUser(db: PGlite, id: string): Promise<void> {
  await db.query("DELETE FROM auth.users WHERE id = $1", [id]);
}

/**
 * Act as a user: subsequent `auth.uid()` calls (RLS policies, column
 * DEFAULTs) return this id until changed. Session-scoped (is_local=false),
 * so it survives the SET ROLE / RESET ROLE round-trips in `callAs`.
 * Sequential use only: PGlite is a single connection.
 */
export async function setTestUser(db: PGlite, id: string): Promise<void> {
  await db.query("SELECT set_config('app.current_user_id', $1, false)", [id]);
}

/**
 * Run one parametrised query as the given role, restoring the session role
 * afterwards. Sequential use only: PGlite is a single connection, so two
 * concurrent callAs calls would interleave their SET ROLEs. For parallel
 * batches, set the role once around the whole batch instead (see the
 * parallel-reserves test).
 */
export async function callAs<T>(
  db: PGlite,
  role: "anon" | "authenticated" | "service_role",
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: T[] }> {
  await db.query(`SET ROLE ${role}`);
  try {
    return await db.query<T>(sql, params);
  } finally {
    await db.query("RESET ROLE");
  }
}

/** Today's date in Asia/Kolkata, as the database computes it. */
export async function kolkataToday(db: PGlite): Promise<string> {
  const r = await db.query<{ d: Date | string }>(
    "SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d",
  );
  const value = r.rows[0].d;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/** Current model_calls for a user (read as superuser, for assertions). */
export async function usageCount(db: PGlite, userId: string): Promise<number> {
  const r = await db.query<{ model_calls: number }>(
    "SELECT model_calls FROM api_usage WHERE user_id = $1",
    [userId],
  );
  return r.rows.length === 0 ? 0 : r.rows[0].model_calls;
}

/** Current web-search count for a user (sum across days, read as
 * superuser, for assertions). One row per day; silent research and
 * the web_search tool share this counter. */
export async function searchCount(db: PGlite, userId: string): Promise<number> {
  const r = await db.query<{ total: number }>(
    "SELECT COALESCE(SUM(searches), 0) AS total FROM search_usage WHERE user_id = $1",
    [userId],
  );
  return Number(r.rows[0]?.total ?? 0);
}

/** The user's action_logs rows, oldest first (read as superuser). */
export async function activityRows(
  db: PGlite,
  userId: string,
): Promise<
  Array<{
    tool_name: string;
    parameters: unknown;
    execution_status: string;
    result_payload: unknown;
    conversation_id: string | null;
    tool_call_id: string;
  }>
> {
  const r = await db.query<{
    tool_name: string;
    parameters: unknown;
    execution_status: string;
    result_payload: unknown;
    conversation_id: string | null;
    tool_call_id: string;
  }>(
    "SELECT tool_name, parameters, execution_status, result_payload, conversation_id, tool_call_id FROM action_logs WHERE user_id = $1 ORDER BY created_at ASC, id ASC",
    [userId],
  );
  return r.rows;
}
