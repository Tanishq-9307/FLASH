// M3-10 tests (ARCHITECTURE.md §5.5, §5.7, DATABASE.md §5.3).
//
// Rollback verification: a failed write inside execute_approved_action
// leaves nothing behind — the claim rolls back, no row is written, the
// log is untouched, no tool message is appended, and the error the
// caller sees is sanitised (the code only, never SQL text or
// internals). The failure is recorded by a separate call afterwards
// (record_execution_failure, M3-11), because anything written inside
// the rolled-back transaction would vanish with it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { callAs, createTestDb, createTestUser, setTestUser } from "./helpers";

describe("execute_approved_action rollback verification (M3-10)", () => {
  let db: PGlite;
  let userA: string;
  let conversationA: string;

  const propose = async (tool: string, params: string): Promise<string> => {
    const r = await callAs<{ approval_id: string }>(
      db,
      "service_role",
      "SELECT approval_id FROM create_pending_approval($1, $2, $3, $4, $5, $6)",
      [userA, conversationA, "call-1", tool, params, 300],
    );
    return r.rows[0].approval_id;
  };

  const approveAndExecute = async (approvalId: string) => {
    await setTestUser(db, userA);
    await callAs(db, "authenticated", "SELECT approval_id FROM approve_action($1)", [
      approvalId,
    ]);
    return callAs<{
      result_code: string;
      result_payload: Record<string, unknown>;
    }>(
      db,
      "authenticated",
      "SELECT result_code, result_payload FROM execute_approved_action($1)",
      [approvalId],
    );
  };

  const approvalState = async (approvalId: string) => {
    const row = await db.query<{ status: string; retry_count: number }>(
      "SELECT status, retry_count FROM tool_approvals WHERE id = $1",
      [approvalId],
    );
    return row.rows[0];
  };

  const logState = async (approvalId: string) => {
    const row = await db.query<{ execution_status: string }>(
      "SELECT execution_status FROM action_logs WHERE approval_id = $1",
      [approvalId],
    );
    return row.rows[0].execution_status;
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
    await db.query("DELETE FROM memories");
    await db.query("DELETE FROM messages");
    await setTestUser(db, userA);
  });

  it("a create_task failure (unparseable due date) leaves nothing behind", async () => {
    const approvalId = await propose(
      "create_task",
      JSON.stringify({ title: "Buy milk", due_date: "not-a-date" }),
    );
    const r = await approveAndExecute(approvalId);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].result_code).toBe("tool_error");
    const approval = await approvalState(approvalId);
    expect(approval.status).toBe("approved");
    expect(approval.retry_count).toBe(0);
    const tasks = await db.query<{ n: string }>("SELECT count(*) AS n FROM tasks");
    expect(Number(tasks.rows[0].n)).toBe(0);
    expect(await logState(approvalId)).toBe("pending");
    expect(await toolMessages()).toBe(0);
  });

  it("a save_memory failure (empty fact) leaves nothing behind", async () => {
    const approvalId = await propose(
      "save_memory",
      JSON.stringify({ fact: "   " }),
    );
    const r = await approveAndExecute(approvalId);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].result_code).toBe("tool_error");
    const approval = await approvalState(approvalId);
    expect(approval.status).toBe("approved");
    expect(approval.retry_count).toBe(0);
    const memories = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM memories",
    );
    expect(Number(memories.rows[0].n)).toBe(0);
    expect(await logState(approvalId)).toBe("pending");
    expect(await toolMessages()).toBe(0);
  });

  it("the error returned to the caller is sanitised: code only, no SQL text", async () => {
    const approvalId = await propose(
      "create_task",
      JSON.stringify({ title: "x".repeat(300) }),
    );
    const r = await approveAndExecute(approvalId);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].result_code).toBe("tool_error");
    // The payload is exactly the code — no constraint name, no table
    // or column name, no SQL text of any kind.
    expect(r.rows[0].result_payload).toEqual({ error: "tool_error" });
    const serialised = JSON.stringify(r.rows[0].result_payload);
    expect(serialised).not.toMatch(/tasks_title_check|CHECK|violates|timestamptz|INSERT|UPDATE/i);
    // Nothing partial remains and no message was appended either.
    expect(await approvalState(approvalId)).toEqual({
      status: "approved",
      retry_count: 0,
    });
    const tasks = await db.query<{ n: string }>("SELECT count(*) AS n FROM tasks");
    expect(Number(tasks.rows[0].n)).toBe(0);
    expect(await logState(approvalId)).toBe("pending");
    expect(await toolMessages()).toBe(0);
  });
});
