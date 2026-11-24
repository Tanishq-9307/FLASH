// M3-14 tests (ARCHITECTURE.md §4.4, DATABASE.md §4, §5.4, §6).
//
// Catalog-driven privilege matrix: every function and table in the
// public schema is accounted for. The catalog is read from the
// database itself (pg_proc / pg_class / pg_default_acl), so a function
// or table added later with the wrong grants fails this test instead
// of slipping through unnoticed. Grants are checked two ways: the
// catalog (has_*_privilege) and live denial attempts. RLS, default
// privileges, search_path, and the account-deletion cascade are
// proved behaviourally.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  callAs,
  createTestDb,
  createTestUser,
  deleteTestUser,
  setTestUser,
} from "./helpers";

/** pg_get_function_identity_arguments returns "p_user_id uuid, ..." —
 * drop the parameter names, keeping only the types, for comparison
 * with the expected signatures. */
function argTypes(identityArgs: string): string {
  if (identityArgs.trim() === "") return "";
  return identityArgs
    .split(", ")
    .map((part) => part.replace(/^[a-z_][a-z0-9_]*\s+/, ""))
    .join(", ");
}

// Expected API functions: name -> argument list (as
// pg_get_function_identity_arguments reports it) and which roles may
// execute. The M3 task counts 12 functions (9 service-role + 3
// authenticated); save_document_extraction (M5, service-role),
// reserve_search / refund_search (M6, service-role) and record_api_call /
// record_search (usage meters 2026-11-24, service-role) are also in this
// database, so the catalog covers 17 — a function missing from this
// map fails the test.
const EXPECTED_FUNCTIONS: Record<
  string,
  {
    args: string;
    secdef: boolean;
    anon: boolean;
    authenticated: boolean;
    service_role: boolean;
  }
> = {
  // Service-role only.
  reserve_api_call: {
    args: "uuid, integer",
    secdef: true,
    anon: false,
    authenticated: false,
    service_role: true,
  },
  refund_api_call: {
    args: "uuid, date",
    secdef: true,
    anon: false,
    authenticated: false,
    service_role: true,
  },
  reserve_search: {
    args: "uuid, integer",
    secdef: true,
    anon: false,
    authenticated: false,
    service_role: true,
  },
  record_api_call: {
    args: "uuid",
    secdef: true,
    anon: false,
    authenticated: false,
    service_role: true,
  },
  record_search: {
    args: "uuid",
    secdef: true,
    anon: false,
    authenticated: false,
    service_role: true,
  },
  refund_search: {
    args: "uuid, date",
    secdef: true,
    anon: false,
    authenticated: false,
    service_role: true,
  },
  create_pending_approval: {
    args: "uuid, uuid, text, text, jsonb, integer",
    secdef: true,
    anon: false,
    authenticated: false,
    service_role: true,
  },
  log_read_only_action: {
    args: "uuid, uuid, text, text, jsonb, text, jsonb",
    secdef: true,
    anon: false,
    authenticated: false,
    service_role: true,
  },
  record_execution_failure: {
    args: "uuid, uuid, jsonb",
    secdef: true,
    anon: false,
    authenticated: false,
    service_role: true,
  },
  record_claim_failure: {
    args: "uuid, uuid, text, boolean",
    secdef: true,
    anon: false,
    authenticated: false,
    service_role: true,
  },
  expire_stale_approval: {
    args: "uuid, uuid",
    secdef: true,
    anon: false,
    authenticated: false,
    service_role: true,
  },
  mark_outcome_delivered: {
    args: "uuid, uuid",
    secdef: true,
    anon: false,
    authenticated: false,
    service_role: true,
  },
  append_message: {
    args: "uuid, uuid, text, text, jsonb, text",
    secdef: true,
    anon: false,
    authenticated: false,
    service_role: true,
  },
  save_document_extraction: {
    args: "uuid, uuid, text, jsonb, text",
    secdef: true,
    anon: false,
    authenticated: false,
    service_role: true,
  },
  // Authenticated only.
  approve_action: {
    args: "uuid",
    secdef: true,
    anon: false,
    authenticated: true,
    service_role: false,
  },
  reject_action: {
    args: "uuid",
    secdef: true,
    anon: false,
    authenticated: true,
    service_role: false,
  },
  execute_approved_action: {
    args: "uuid",
    secdef: true,
    anon: false,
    authenticated: true,
    service_role: false,
  },
};

// Internal helpers: no API role may execute them. They run only as
// the owner, called from the SECURITY DEFINER functions above.
const EXPECTED_HELPERS: Record<string, { args: string; secdef: boolean }> = {
  m3_params_hash: { args: "jsonb", secdef: false },
  m3_is_approval_tool: { args: "text", secdef: false },
  m3_append_tool_message: {
    args: "uuid, uuid, text, uuid, text, text, text",
    secdef: true,
  },
  m3_settle: { args: "uuid, uuid, text, jsonb", secdef: true },
  m3_expire: { args: "uuid, uuid", secdef: true },
};

const EXPECTED_TABLES = [
  "action_logs",
  "api_usage",
  "conversations",
  "document_pages",
  "documents",
  "memories",
  "messages",
  "notes",
  "search_usage",
  "settings",
  "tasks",
  "tool_approvals",
];

describe("database privilege matrix and retention (M3-14)", () => {
  let db: PGlite;
  let userA: string;

  beforeAll(async () => {
    db = await createTestDb();
    userA = await createTestUser(db);
    await setTestUser(db, userA);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM action_logs");
    await db.query("DELETE FROM tool_approvals");
    await db.query("DELETE FROM tasks");
    await db.query("DELETE FROM memories");
    await db.query("DELETE FROM messages");
    await db.query("DELETE FROM conversations");
    await setTestUser(db, userA);
  });

  it("every function is catalogued with the right signature, grants and SECURITY DEFINER", async () => {
    const rows = await db.query<{
      oid: string;
      name: string;
      args: string;
      secdef: boolean;
    }>(
      `SELECT p.oid::text AS oid, p.proname AS name,
              pg_get_function_identity_arguments(p.oid) AS args,
              p.prosecdef AS secdef
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prokind = 'f'
          AND p.prorettype <> 'trigger'::regtype
        ORDER BY p.proname`,
    );
    const found = rows.rows.map((r) => r.name).sort();
    const expected = [
      ...Object.keys(EXPECTED_FUNCTIONS),
      ...Object.keys(EXPECTED_HELPERS),
    ].sort();
    expect(found).toEqual(expected);

    for (const row of rows.rows) {
      const spec =
        EXPECTED_FUNCTIONS[row.name] ?? EXPECTED_HELPERS[row.name];
      expect(argTypes(row.args)).toBe(spec.args);
      expect(row.secdef).toBe(spec.secdef);
      const grants = "authenticated" in spec ? spec : null;
      for (const role of ["anon", "authenticated", "service_role"] as const) {
        const allowed = await db.query<{ ok: boolean }>(
          "SELECT has_function_privilege($1, $2::oid, 'execute') AS ok",
          [role, row.oid],
        );
        const want = grants ? grants[role] : false;
        expect(
          allowed.rows[0].ok,
          `${row.name} execute for ${role}`,
        ).toBe(want);
      }
    }
  });

  it("live calls are denied for the wrong roles, including the internal helpers", async () => {
    // Service-role function as anon and authenticated.
    await expect(
      callAs(db, "anon", "SELECT * FROM reserve_api_call($1, 20)", [userA]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      callAs(
        db,
        "authenticated",
        "SELECT * FROM reserve_api_call($1, 20)",
        [userA],
      ),
    ).rejects.toThrow(/permission denied/);
    // Authenticated function as anon.
    await expect(
      callAs(db, "anon", "SELECT * FROM approve_action($1)", [
        "00000000-0000-0000-0000-000000000000",
      ]),
    ).rejects.toThrow(/permission denied/);
    // Internal helper as service_role: no API role may call it.
    await expect(
      callAs(
        db,
        "service_role",
        "SELECT * FROM m3_settle($1, $2, 'failed', '{}'::jsonb)",
        [userA, "00000000-0000-0000-0000-000000000000"],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      callAs(db, "service_role", "SELECT m3_params_hash('{}'::jsonb)"),
    ).rejects.toThrow(/permission denied/);
  });

  it("RLS is enabled on every table, and the table set is exactly the expected 12", async () => {
    const rows = await db.query<{ name: string; rls: boolean }>(
      `SELECT c.relname AS name, c.relrowsecurity AS rls
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname`,
    );
    expect(rows.rows.map((r) => r.name).sort()).toEqual(
      [...EXPECTED_TABLES].sort(),
    );
    for (const row of rows.rows) {
      expect(row.rls, `RLS on ${row.name}`).toBe(true);
    }
  });

  it("client INSERT/UPDATE/DELETE on the security tables is blocked by grants and by policy", async () => {
    // Seed one approval + log for userA (via the service-role function).
    const conv = await callAs<{ id: string }>(
      db,
      "authenticated",
      "INSERT INTO conversations (title) VALUES ('A') RETURNING id",
    );
    const conversationId = conv.rows[0].id;
    const approval = await callAs<{ approval_id: string }>(
      db,
      "service_role",
      "SELECT approval_id FROM create_pending_approval($1, $2, $3, $4, $5, $6)",
      [userA, conversationId, "call-1", "create_task", '{"title":"x"}', 300],
    );
    const approvalId = approval.rows[0].approval_id;
    // Seed one api_usage row via the service-role function.
    await callAs(db, "service_role", "SELECT * FROM reserve_api_call($1, 20)", [
      userA,
    ]);

    await setTestUser(db, userA);
    // Live attempts fail at the grant layer: authenticated holds only
    // SELECT on these tables, so the write is refused before any
    // policy is evaluated.
    const denied = /permission denied for table/;
    await expect(
      callAs(
        db,
        "authenticated",
        `INSERT INTO tool_approvals (user_id, conversation_id, tool_call_id, tool_name, parameters, parameters_hash, expires_at, status)
         VALUES ($1, $2, 'call-2', 'create_task', '{}', 'x', now() + interval '5 minutes', 'pending')`,
        [userA, conversationId],
      ),
    ).rejects.toThrow(denied);
    await expect(
      callAs(
        db,
        "authenticated",
        "UPDATE tool_approvals SET status = 'rejected' WHERE id = $1",
        [approvalId],
      ),
    ).rejects.toThrow(denied);
    await expect(
      callAs(db, "authenticated", "DELETE FROM tool_approvals WHERE id = $1", [
        approvalId,
      ]),
    ).rejects.toThrow(denied);
    await expect(
      callAs(
        db,
        "authenticated",
        `INSERT INTO action_logs (user_id, conversation_id, tool_call_id, tool_name, parameters, approval_id, execution_status)
         VALUES ($1, $2, 'call-9', 'create_task', '{}', $3, 'pending')`,
        [userA, conversationId, approvalId],
      ),
    ).rejects.toThrow(denied);
    await expect(
      callAs(
        db,
        "authenticated",
        "UPDATE action_logs SET execution_status = 'failed' WHERE approval_id = $1",
        [approvalId],
      ),
    ).rejects.toThrow(denied);
    await expect(
      callAs(
        db,
        "authenticated",
        "DELETE FROM action_logs WHERE approval_id = $1",
        [approvalId],
      ),
    ).rejects.toThrow(denied);
    await expect(
      callAs(
        db,
        "authenticated",
        "INSERT INTO api_usage (user_id, usage_date, model_calls) VALUES ($1, CURRENT_DATE, 1)",
        [userA],
      ),
    ).rejects.toThrow(denied);
    await expect(
      callAs(
        db,
        "authenticated",
        "DELETE FROM api_usage WHERE user_id = $1",
        [userA],
      ),
    ).rejects.toThrow(denied);

    // Policy layer: only SELECT policies exist on these tables, so
    // even a future grant could not open a write path.
    const policies = await db.query<{ table: string; cmd: string }>(
      `SELECT tablename AS "table", cmd FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ('tool_approvals', 'action_logs', 'api_usage', 'search_usage')`,
    );
    expect(policies.rows.length).toBeGreaterThan(0);
    for (const policy of policies.rows) {
      expect(policy.cmd, `policy on ${policy.table}`).toBe("SELECT");
    }

    // Grant catalog: authenticated can SELECT but not write.
    for (const table of ["tool_approvals", "action_logs", "api_usage", "search_usage"]) {
      for (const priv of ["INSERT", "UPDATE", "DELETE"] as const) {
        const r = await db.query<{ ok: boolean }>(
          "SELECT has_table_privilege('authenticated', $1, $2) AS ok",
          [`public.${table}`, priv],
        );
        expect(r.rows[0].ok, `${priv} on ${table}`).toBe(false);
      }
      const sel = await db.query<{ ok: boolean }>(
        "SELECT has_table_privilege('authenticated', $1, 'SELECT') AS ok",
        [`public.${table}`],
      );
      expect(sel.rows[0].ok, `SELECT on ${table}`).toBe(true);
    }

    // Control: the same role can write its own task (owner policy).
    const task = await callAs<{ id: string }>(
      db,
      "authenticated",
      "INSERT INTO tasks (title) VALUES ('control') RETURNING id",
    );
    expect(task.rows).toHaveLength(1);
    const deleted = await callAs<{ id: string }>(
      db,
      "authenticated",
      "DELETE FROM tasks WHERE id = $1 RETURNING id",
      [task.rows[0].id],
    );
    expect(deleted.rows).toHaveLength(1);
  });

  it("default privileges are declared in the migrations (live proof deferred: PGlite ignores ALTER DEFAULT PRIVILEGES)", async () => {
    // PGlite limitation, proved by the M3-14 audit: ALTER DEFAULT
    // PRIVILEGES parses and is accepted, but pg_default_acl stays
    // empty and a fresh function still gets PUBLIC execute. So the
    // behavioural proof — a new table/function inheriting no broad
    // grants — cannot run in this test database; it belongs on the
    // live dev-project checklist (M3-27 security review). What this
    // build can prove is that the declarations exist in the
    // migrations, and every object that exists today already has the
    // right grants (the catalog test above proves that live). The
    // helpers are additionally protected by explicit REVOKEs
    // (migration 20261123174117_m3_helper_revokes.sql), which do work
    // in PGlite.
    const dir = join(process.cwd(), "supabase", "migrations");
    const sql = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
    expect(sql).toMatch(
      /ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated/,
    );
    expect(sql).toMatch(
      /ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated/,
    );
    // Tripwire: this documents that the limitation is still present.
    // If a future PGlite starts enforcing ALTER DEFAULT PRIVILEGES,
    // this fails and the test should become the behavioural probe.
    const defaults = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_default_acl",
    );
    expect(Number(defaults.rows[0].n)).toBe(0);
  });

  it("search_path is fixed on every SECURITY DEFINER function", async () => {
    const rows = await db.query<{ name: string; config: string[] | null }>(
      `SELECT p.proname AS name, p.proconfig AS config
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef = true
        ORDER BY p.proname`,
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      const config = row.config ?? [];
      expect(
        config.some((c) => c.startsWith("search_path=")),
        `search_path on SECURITY DEFINER ${row.name}`,
      ).toBe(true);
    }
  });

  it("deleting an account cascades to every row it owns", async () => {
    const doomed = await createTestUser(db);
    await setTestUser(db, doomed);
    const conv = await callAs<{ id: string }>(
      db,
      "authenticated",
      "INSERT INTO conversations (title) VALUES ('doomed') RETURNING id",
    );
    const conversationId = conv.rows[0].id;
    await callAs(
      db,
      "service_role",
      "SELECT approval_id FROM create_pending_approval($1, $2, $3, $4, $5, $6)",
      [doomed, conversationId, "call-1", "create_task", '{"title":"x"}', 300],
    );
    await callAs(
      db,
      "service_role",
      "SELECT append_message($1, $2, 'assistant', 'hello', '[]'::jsonb, NULL)",
      [doomed, conversationId],
    );
    await callAs(db, "authenticated", "INSERT INTO tasks (title) VALUES ('t')", []);
    await callAs(
      db,
      "authenticated",
      "INSERT INTO memories (fact) VALUES ('doomed fact')",
      [],
    );
    await db.query(
      "INSERT INTO settings (user_id, memory_enabled) VALUES ($1, true)",
      [doomed],
    );
    await db.query(
      "INSERT INTO api_usage (user_id, usage_date, model_calls) VALUES ($1, CURRENT_DATE, 3)",
      [doomed],
    );

    // A second user's data must survive the delete.
    await setTestUser(db, userA);
    const keeper = await callAs<{ id: string }>(
      db,
      "authenticated",
      "INSERT INTO conversations (title) VALUES ('keeper') RETURNING id",
    );

    await deleteTestUser(db, doomed);

    for (const table of [
      "conversations",
      "messages",
      "tasks",
      "notes",
      "memories",
      "tool_approvals",
      "action_logs",
      "settings",
      "api_usage",
    ]) {
      const count = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} WHERE user_id = $1`,
        [doomed],
      );
      expect(Number(count.rows[0].n), `rows left in ${table}`).toBe(0);
    }
    const kept = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM conversations WHERE id = $1",
      [keeper.rows[0].id],
    );
    expect(Number(kept.rows[0].n)).toBe(1);
  });
});
