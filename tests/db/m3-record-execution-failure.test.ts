// M3-11 tests (ARCHITECTURE.md §5.5, §5.7, DATABASE.md §5.1).
//
// record_execution_failure counts failures outside the rolled-back
// execute transaction: one failure leaves the approval approved with
// retry_count 1; the third sets it failed and returns the resume
// flag; a later execution then returns `exhausted`.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { callAs, createTestDb, createTestUser, setTestUser } from "./helpers";

describe("record_execution_failure (M3-11)", () => {
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

  const recordFailure = (
    role: "anon" | "authenticated" | "service_role",
    approvalId: string,
    userId: string,
  ) =>
    callAs<{ retry_count: number; failed: boolean }>(
      db,
      role,
      "SELECT retry_count, failed FROM record_execution_failure($1, $2, $3)",
      [approvalId, userId, JSON.stringify({ error: "tool_error" })],
    );

  const approvalState = async (approvalId: string) => {
    const row = await db.query<{ status: string; retry_count: number }>(
      "SELECT status, retry_count FROM tool_approvals WHERE id = $1",
      [approvalId],
    );
    return row.rows[0];
  };

  const logState = async (approvalId: string) => {
    const row = await db.query<{
      execution_status: string;
      result_payload: unknown;
    }>(
      "SELECT execution_status, result_payload FROM action_logs WHERE approval_id = $1",
      [approvalId],
    );
    return row.rows[0];
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
    await db.query("DELETE FROM tasks");
    await db.query("DELETE FROM messages");
    await setTestUser(db, userA);
  });

  it("one failure leaves approved with count 1, log pending, no message", async () => {
    const approvalId = await proposeAndApprove();
    const r = await recordFailure("service_role", approvalId, userA);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toEqual({ retry_count: 1, failed: false });
    expect(await approvalState(approvalId)).toEqual({
      status: "approved",
      retry_count: 1,
    });
    const log = await logState(approvalId);
    expect(log.execution_status).toBe("pending");
    expect(log.result_payload).toEqual({ error: "tool_error" });
    expect(await toolMessages()).toBe(0);
  });

  it("the third failure sets failed, settles the log, appends the message, returns the flag", async () => {
    const approvalId = await proposeAndApprove();
    await recordFailure("service_role", approvalId, userA);
    const second = await recordFailure("service_role", approvalId, userA);
    expect(second.rows[0]).toEqual({ retry_count: 2, failed: false });
    const third = await recordFailure("service_role", approvalId, userA);
    expect(third.rows).toHaveLength(1);
    expect(third.rows[0]).toEqual({ retry_count: 3, failed: true });
    expect(await approvalState(approvalId)).toEqual({
      status: "failed",
      retry_count: 3,
    });
    const log = await logState(approvalId);
    expect(log.execution_status).toBe("failed");
    expect(log.result_payload).toEqual({ error: "tool_error" });
    const msg = await db.query<{ outcome: string; content: string }>(
      `SELECT parts->>'outcome' AS outcome, content FROM messages
        WHERE tool_call_id = 'call-1' AND role = 'tool'`,
    );
    expect(msg.rows).toHaveLength(1);
    expect(msg.rows[0].outcome).toBe("failed");
    expect(msg.rows[0].content).toContain("3 attempts");
    // A fourth call is a no-op: the approval is no longer approved.
    const fourth = await recordFailure("service_role", approvalId, userA);
    expect(fourth.rows).toHaveLength(0);
  });

  it("later execution returns exhausted", async () => {
    const approvalId = await proposeAndApprove();
    await recordFailure("service_role", approvalId, userA);
    await recordFailure("service_role", approvalId, userA);
    await recordFailure("service_role", approvalId, userA);
    await setTestUser(db, userA);
    const r = await callAs<{ result_code: string }>(
      db,
      "authenticated",
      "SELECT result_code FROM execute_approved_action($1)",
      [approvalId],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].result_code).toBe("exhausted");
  });

  it("anon and authenticated are denied, and a foreign user gets no row", async () => {
    const approvalId = await proposeAndApprove();
    await expect(recordFailure("anon", approvalId, userA)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      recordFailure("authenticated", approvalId, userA),
    ).rejects.toThrow(/permission denied/);
    const foreign = await recordFailure("service_role", approvalId, userB);
    expect(foreign.rows).toHaveLength(0);
    expect(await approvalState(approvalId)).toEqual({
      status: "approved",
      retry_count: 0,
    });
  });
});
