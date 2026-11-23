// M3-13 tests (ARCHITECTURE.md §4.4, §7, DATABASE.md §5.1).
//
// mark_outcome_delivered stamps outcome_delivered_at exactly once,
// only for final states: ten parallel calls return exactly one row,
// and non-final states return nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { callAs, createTestDb, createTestUser, setTestUser } from "./helpers";

describe("mark_outcome_delivered (M3-13)", () => {
  let db: PGlite;
  let userA: string;
  let userB: string;

  const seedApproval = async (status: string): Promise<string> => {
    // Each seed gets its own conversation: the one-open-approval
    // partial index forbids two open (pending/approved) approvals in
    // the same conversation.
    const conv = await callAs<{ id: string }>(
      db,
      "authenticated",
      "INSERT INTO conversations (title) VALUES ('seed') RETURNING id",
    );
    const r = await db.query<{ id: string }>(
      `INSERT INTO tool_approvals
        (user_id, conversation_id, tool_call_id, tool_name, parameters, parameters_hash,
         expires_at, status, approved_at, consumed_at)
        VALUES ($1, $2, $3, 'create_task', '{"title":"seeded"}',
                m3_params_hash('{"title":"seeded"}'::jsonb),
                now() + interval '5 minutes', $4, now(),
                CASE WHEN $4 = 'consumed' THEN now() ELSE NULL END)
        RETURNING id`,
      [
        userA,
        conv.rows[0].id,
        `call-${Date.now()}-${Math.random()}`,
        status,
      ],
    );
    return r.rows[0].id;
  };

  const mark = (
    role: "anon" | "authenticated" | "service_role",
    approvalId: string,
    userId: string,
  ) =>
    callAs<{ approval_id: string; outcome_delivered_at: string }>(
      db,
      role,
      "SELECT approval_id, outcome_delivered_at FROM mark_outcome_delivered($1, $2)",
      [userId, approvalId],
    );

  beforeAll(async () => {
    db = await createTestDb();
    userA = await createTestUser(db);
    userB = await createTestUser(db);
    await setTestUser(db, userA);
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

  it("ten parallel calls succeed exactly once", async () => {
    const approvalId = await seedApproval("consumed");
    // One role for the whole batch: SET ROLE is session state on
    // PGlite's single connection, so per-call role switches would
    // interleave (same pattern as the rate-limit parallel test).
    await db.query("SET ROLE service_role");
    let rows: number;
    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          db.query(
            "SELECT approval_id FROM mark_outcome_delivered($1, $2)",
            [userA, approvalId],
          ),
        ),
      );
      rows = results.reduce((n, r) => n + r.rows.length, 0);
    } finally {
      await db.query("RESET ROLE");
    }
    expect(rows).toBe(1);
    const row = await db.query<{ outcome_delivered_at: string | null }>(
      "SELECT outcome_delivered_at FROM tool_approvals WHERE id = $1",
      [approvalId],
    );
    expect(row.rows[0].outcome_delivered_at).not.toBeNull();
  });

  it("non-final states return nothing, and each final state stamps once", async () => {
    for (const status of ["pending", "approved"]) {
      const approvalId = await seedApproval(status);
      const r = await mark("service_role", approvalId, userA);
      expect(r.rows).toHaveLength(0);
      const row = await db.query<{ outcome_delivered_at: string | null }>(
        "SELECT outcome_delivered_at FROM tool_approvals WHERE id = $1",
        [approvalId],
      );
      expect(row.rows[0].outcome_delivered_at).toBeNull();
    }
    for (const status of ["rejected", "expired", "failed"]) {
      const approvalId = await seedApproval(status);
      const first = await mark("service_role", approvalId, userA);
      expect(first.rows).toHaveLength(1);
      expect(first.rows[0].approval_id).toBe(approvalId);
      const second = await mark("service_role", approvalId, userA);
      expect(second.rows).toHaveLength(0);
    }
  });

  it("anon and authenticated are denied, and a foreign user gets no row", async () => {
    const approvalId = await seedApproval("consumed");
    await expect(mark("anon", approvalId, userA)).rejects.toThrow(
      /permission denied/,
    );
    await expect(mark("authenticated", approvalId, userA)).rejects.toThrow(
      /permission denied/,
    );
    const foreign = await mark("service_role", approvalId, userB);
    expect(foreign.rows).toHaveLength(0);
    const row = await db.query<{ outcome_delivered_at: string | null }>(
      "SELECT outcome_delivered_at FROM tool_approvals WHERE id = $1",
      [approvalId],
    );
    expect(row.rows[0].outcome_delivered_at).toBeNull();
  });
});
