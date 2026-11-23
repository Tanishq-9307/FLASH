// M3-7 tests (ARCHITECTURE.md §5.4–§5.7, DATABASE.md §5.3, §6).
//
// execute_approved_action claims an approved approval exactly once
// (one conditional UPDATE), classifies a failed claim without writing
// anything, and dispatches through a hardcoded branch. In this task
// the dispatch is a stub: known tools return `claimed` without writing
// anything, unknown tools raise and the claim rolls back to
// `tool_error`.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { callAs, createTestDb, createTestUser, setTestUser } from "./helpers";

describe("execute_approved_action claim and classification (M3-7)", () => {
  let db: PGlite;
  let userA: string;
  let userB: string;
  let conversationA: string;

  const propose = async (ttl = 300): Promise<string> => {
    const r = await callAs<{ approval_id: string }>(
      db,
      "service_role",
      "SELECT approval_id FROM create_pending_approval($1, $2, $3, $4, $5, $6)",
      [userA, conversationA, "call-1", "create_task", '{"title":"Buy milk"}', ttl],
    );
    return r.rows[0].approval_id;
  };

  const approve = async (approvalId: string) => {
    await setTestUser(db, userA);
    return callAs<{ approval_id: string; approval_status: string }>(
      db,
      "authenticated",
      "SELECT approval_id, approval_status FROM approve_action($1)",
      [approvalId],
    );
  };

  const execute = (role: "anon" | "authenticated", approvalId: string) =>
    callAs<{ result_code: string; result_payload: unknown }>(
      db,
      role,
      "SELECT result_code, result_payload FROM execute_approved_action($1)",
      [approvalId],
    );

  /** Seed one approval directly (superuser: bypasses RLS and the
   * create_pending_approval allowlist) and return its id. */
  const seedApproval = async (overrides: {
    tool?: string;
    params?: string;
    status?: string;
    expiresInMinutes?: number;
    retryCount?: number;
  }): Promise<string> => {
    const tool = overrides.tool ?? "create_task";
    const params = overrides.params ?? '{"title":"seeded"}';
    const status = overrides.status ?? "approved";
    const minutes = overrides.expiresInMinutes ?? 5;
    const retryCount = overrides.retryCount ?? 0;
    const r = await db.query<{ id: string }>(
      `INSERT INTO tool_approvals
        (user_id, conversation_id, tool_call_id, tool_name, parameters, parameters_hash,
         expires_at, status, approved_at, consumed_at, retry_count)
        VALUES ($1, $2, $3, $4, $5, m3_params_hash($5::jsonb),
                now() + ($6 || ' minutes')::interval, $7, now(),
                CASE WHEN $7 = 'consumed' THEN now() ELSE NULL END, $8)
        RETURNING id`,
      [
        userA,
        conversationA,
        `call-${Date.now()}-${Math.random()}`,
        tool,
        params,
        String(minutes),
        status,
        retryCount,
      ],
    );
    return r.rows[0].id;
  };

  const statusOf = async (approvalId: string) => {
    const row = await db.query<{ status: string; retry_count: number }>(
      "SELECT status, retry_count FROM tool_approvals WHERE id = $1",
      [approvalId],
    );
    return row.rows[0];
  };

  beforeAll(async () => {
    db = await createTestDb();
    userA = await createTestUser(db);
    userB = await createTestUser(db);
    await setTestUser(db, userA);
    const a = await callAs<{ id: string }>(
      db,
      "authenticated",
      "INSERT INTO conversations (title) VALUES ('A') RETURNING id",
    );
    conversationA = a.rows[0].id;
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM action_logs");
    await db.query("DELETE FROM tool_approvals");
    await db.query("DELETE FROM messages");
    await setTestUser(db, userA);
  });

  it("five parallel calls give exactly one claimed and four replay", async () => {
    const approvalId = await propose();
    await approve(approvalId);
    // One role for the whole batch: SET ROLE is session state on
    // PGlite's single connection, so per-call role switches would
    // interleave (same pattern as the rate-limit parallel test).
    await db.query("SET ROLE authenticated");
    let codes: string[];
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          db.query<{ result_code: string }>(
            "SELECT result_code FROM execute_approved_action($1)",
            [approvalId],
          ),
        ),
      );
      codes = results.flatMap((r) => r.rows.map((row) => row.result_code));
    } finally {
      await db.query("RESET ROLE");
    }
    expect(codes.filter((c) => c === "claimed")).toHaveLength(1);
    expect(codes.filter((c) => c === "replay")).toHaveLength(4);
    const row = await statusOf(approvalId);
    expect(row.status).toBe("consumed");
  });

  it("a dispatch error returns tool_error and the claim is rolled back", async () => {
    // An unknown tool cannot be proposed through create_pending_approval
    // (allowlist), so the row is seeded directly as approved.
    const approvalId = await seedApproval({ tool: "teleport", params: "{}" });
    const r = await execute("authenticated", approvalId);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].result_code).toBe("tool_error");
    // The payload carries only the code — no SQL text or internals.
    expect(r.rows[0].result_payload).toEqual({ error: "tool_error" });
    const row = await statusOf(approvalId);
    expect(row.status).toBe("approved");
    expect(row.retry_count).toBe(0);
  });

  it("a pending approval gives not_approved and stays pending", async () => {
    const approvalId = await propose();
    const r = await execute("authenticated", approvalId);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].result_code).toBe("not_approved");
    const row = await statusOf(approvalId);
    expect(row.status).toBe("pending");
  });

  it("a consumed approval gives replay", async () => {
    const approvalId = await seedApproval({ status: "consumed" });
    const r = await execute("authenticated", approvalId);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].result_code).toBe("replay");
  });

  it("an expired approval gives expired", async () => {
    const approvalId = await seedApproval({ expiresInMinutes: -1 });
    const r = await execute("authenticated", approvalId);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].result_code).toBe("expired");
    const row = await statusOf(approvalId);
    expect(row.status).toBe("approved");
  });

  it("tampered parameters give hash_mismatch", async () => {
    const approvalId = await propose();
    await approve(approvalId);
    // Edit the stored parameters as superuser with the immutability
    // trigger disabled for this test only, then re-enabled.
    await db.query(
      'ALTER TABLE tool_approvals DISABLE TRIGGER "tool_approvals_immutable"',
    );
    try {
      await db.query(
        "UPDATE tool_approvals SET parameters = '{\"title\":\"tampered\"}' WHERE id = $1",
        [approvalId],
      );
    } finally {
      await db.query(
        'ALTER TABLE tool_approvals ENABLE TRIGGER "tool_approvals_immutable"',
      );
    }
    const r = await execute("authenticated", approvalId);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].result_code).toBe("hash_mismatch");
    // The trigger is back on: the same edit is refused again.
    await expect(
      db.query(
        "UPDATE tool_approvals SET parameters = '{\"title\":\"again\"}' WHERE id = $1",
        [approvalId],
      ),
    ).rejects.toThrow(/immutable columns cannot change/);
  });

  it("retry_count 3 gives exhausted", async () => {
    const approvalId = await seedApproval({ retryCount: 3 });
    const r = await execute("authenticated", approvalId);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].result_code).toBe("exhausted");
    const row = await statusOf(approvalId);
    expect(row.status).toBe("approved");
  });

  it("another user's approval gives not_approved and anon is denied", async () => {
    const approvalId = await propose();
    await approve(approvalId);
    await setTestUser(db, userB);
    const r = await execute("authenticated", approvalId);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].result_code).toBe("not_approved");
    await expect(execute("anon", approvalId)).rejects.toThrow(/permission denied/);
  });
});
