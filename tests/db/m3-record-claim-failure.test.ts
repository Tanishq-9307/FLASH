// M3-12 tests (ARCHITECTURE.md §4.4, §5.5, DATABASE.md §3.9, §5.1).
//
// record_claim_failure always inserts a `not_executed` audit row with
// the reason. Tamper is decided by the function itself (recomputing
// the hash), not by the caller's flag: a real hash mismatch is
// terminal (approval failed, original log settled with the tamper
// flag, tool message appended, resume flag true), while other reasons
// add only the audit row.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { callAs, createTestDb, createTestUser, setTestUser } from "./helpers";

describe("record_claim_failure (M3-12)", () => {
  let db: PGlite;
  let userA: string;
  let userB: string;
  let conversationA: string;

  const proposeAndApprove = async (): Promise<string> => {
    const r = await callAs<{ approval_id: string }>(
      db,
      "service_role",
      "SELECT approval_id FROM create_pending_approval($1, $2, $3, $4, $5, $6)",
      [userA, conversationA, "call-1", "create_task", '{"title":"Buy milk"}', 300],
    );
    const approvalId = r.rows[0].approval_id;
    await setTestUser(db, userA);
    await callAs(db, "authenticated", "SELECT approval_id FROM approve_action($1)", [
      approvalId,
    ]);
    return approvalId;
  };

  const tamperParameters = async (approvalId: string) => {
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
  };

  const recordClaimFailure = (
    role: "anon" | "authenticated" | "service_role",
    approvalId: string,
    userId: string,
    reason: string,
    isTamper: boolean,
  ) =>
    callAs<{ audit_log_id: string; resume: boolean }>(
      db,
      role,
      "SELECT audit_log_id, resume FROM record_claim_failure($1, $2, $3, $4)",
      [approvalId, userId, reason, isTamper],
    );

  const approvalState = async (approvalId: string) => {
    const row = await db.query<{ status: string; retry_count: number }>(
      "SELECT status, retry_count FROM tool_approvals WHERE id = $1",
      [approvalId],
    );
    return row.rows[0];
  };

  const logsFor = async (approvalId: string) => {
    const row = await db.query<{
      id: string;
      execution_status: string;
      result_payload: Record<string, unknown>;
    }>(
      `SELECT id, execution_status, result_payload FROM action_logs
        WHERE approval_id = $1 ORDER BY created_at ASC`,
      [approvalId],
    );
    return row.rows;
  };

  const toolMessages = async () => {
    const row = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM messages WHERE role = 'tool'",
    );
    return Number(row.rows[0].n);
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

  it("a hash mismatch is terminal even when the caller says it is not tamper", async () => {
    const approvalId = await proposeAndApprove();
    await tamperParameters(approvalId);
    // The caller claims this is not tamper; the function decides by
    // recomputing the hash, so it is terminal anyway.
    const r = await recordClaimFailure(
      "service_role",
      approvalId,
      userA,
      "hash_mismatch",
      false,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].resume).toBe(true);
    expect(r.rows[0].audit_log_id).toBeTruthy();

    expect(await approvalState(approvalId)).toEqual({
      status: "failed",
      retry_count: 0,
    });

    const logs = await logsFor(approvalId);
    // Two rows: the original pending log (now settled) and the audit row.
    expect(logs).toHaveLength(2);
    const [original, audit] = logs;
    expect(original.execution_status).toBe("not_executed");
    expect(original.result_payload).toEqual({
      reason: "hash_mismatch",
      tamper: true,
    });
    expect(audit.id).toBe(r.rows[0].audit_log_id);
    expect(audit.execution_status).toBe("not_executed");
    expect(audit.result_payload).toEqual({
      reason: "hash_mismatch",
      tamper: true,
      caller_tamper_flag: false,
    });

    const msg = await db.query<{ outcome: string; content: string }>(
      `SELECT parts->>'outcome' AS outcome, content FROM messages
        WHERE tool_call_id = 'call-1' AND role = 'tool'`,
    );
    expect(msg.rows).toHaveLength(1);
    expect(msg.rows[0].outcome).toBe("not_executed");
    expect(msg.rows[0].content).toContain("parameters were changed");
  });

  it("other reasons add only the audit row, and a false tamper claim is not terminal", async () => {
    const approvalId = await proposeAndApprove();
    const r = await recordClaimFailure(
      "service_role",
      approvalId,
      userA,
      "expired",
      false,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].resume).toBe(false);
    expect(await approvalState(approvalId)).toEqual({
      status: "approved",
      retry_count: 0,
    });
    const logs = await logsFor(approvalId);
    expect(logs).toHaveLength(2);
    expect(logs[0].execution_status).toBe("pending");
    expect(logs[1].id).toBe(r.rows[0].audit_log_id);
    expect(logs[1].execution_status).toBe("not_executed");
    expect(logs[1].result_payload).toEqual({
      reason: "expired",
      tamper: false,
      caller_tamper_flag: false,
    });
    expect(await toolMessages()).toBe(0);

    // The caller claims tamper on untampered parameters: recorded,
    // but not terminal — the function decides by recomputation.
    const second = await recordClaimFailure(
      "service_role",
      approvalId,
      userA,
      "hash_mismatch",
      true,
    );
    expect(second.rows[0].resume).toBe(false);
    expect(await approvalState(approvalId)).toEqual({
      status: "approved",
      retry_count: 0,
    });
    const logsAfter = await logsFor(approvalId);
    expect(logsAfter).toHaveLength(3);
    expect(logsAfter[2].result_payload).toEqual({
      reason: "hash_mismatch",
      tamper: false,
      caller_tamper_flag: true,
    });
  });

  it("anon and authenticated are denied, and a foreign user gets no row", async () => {
    const approvalId = await proposeAndApprove();
    await expect(
      recordClaimFailure("anon", approvalId, userA, "expired", false),
    ).rejects.toThrow(/permission denied/);
    await expect(
      recordClaimFailure("authenticated", approvalId, userA, "expired", false),
    ).rejects.toThrow(/permission denied/);
    const foreign = await recordClaimFailure(
      "service_role",
      approvalId,
      userB,
      "expired",
      false,
    );
    expect(foreign.rows).toHaveLength(0);
    const logs = await logsFor(approvalId);
    expect(logs).toHaveLength(1);
    expect(logs[0].execution_status).toBe("pending");
  });
});
