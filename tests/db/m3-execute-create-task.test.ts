// M3-8 tests (ARCHITECTURE.md §5.5, §5.6, DATABASE.md §5.3).
//
// The create_task branch of execute_approved_action writes the task
// with the approval's user_id, updates the log to `succeeded` with
// the result, and appends the tool message — all inside the same
// transaction as the claim.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { callAs, createTestDb, createTestUser, setTestUser } from "./helpers";

describe("execute_approved_action create_task branch (M3-8)", () => {
  let db: PGlite;
  let userA: string;
  let conversationA: string;

  const proposeTask = async (params: string): Promise<string> => {
    const r = await callAs<{ approval_id: string }>(
      db,
      "service_role",
      "SELECT approval_id FROM create_pending_approval($1, $2, $3, $4, $5, $6)",
      [userA, conversationA, "call-1", "create_task", params, 300],
    );
    return r.rows[0].approval_id;
  };

  const approveAndExecute = async (approvalId: string) => {
    await setTestUser(db, userA);
    await callAs(db, "authenticated", "SELECT approval_id FROM approve_action($1)", [
      approvalId,
    ]);
    return callAs<{ result_code: string; result_payload: { task_id?: string } }>(
      db,
      "authenticated",
      "SELECT result_code, result_payload FROM execute_approved_action($1)",
      [approvalId],
    );
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
    await db.query("DELETE FROM messages");
    await setTestUser(db, userA);
  });

  it("claim, task row, log and message all appear", async () => {
    const approvalId = await proposeTask(
      JSON.stringify({ title: "Buy milk", due_date: "2026-12-01T10:00:00Z" }),
    );
    const r = await approveAndExecute(approvalId);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].result_code).toBe("claimed");
    const taskId = r.rows[0].result_payload.task_id;
    expect(taskId).toBeTruthy();

    const task = await db.query<{
      user_id: string;
      title: string;
      due_date: Date | string;
      status: string;
    }>("SELECT user_id, title, due_date, status FROM tasks WHERE id = $1", [taskId]);
    expect(task.rows).toHaveLength(1);
    expect(task.rows[0].user_id).toBe(userA);
    expect(task.rows[0].title).toBe("Buy milk");
    expect(new Date(task.rows[0].due_date).toISOString().slice(0, 10)).toBe(
      "2026-12-01",
    );
    expect(task.rows[0].status).toBe("pending");

    const log = await db.query<{
      execution_status: string;
      result_payload: { task_id?: string };
    }>(
      "SELECT execution_status, result_payload FROM action_logs WHERE approval_id = $1",
      [approvalId],
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].execution_status).toBe("succeeded");
    expect(log.rows[0].result_payload.task_id).toBe(taskId);

    const msg = await db.query<{ role: string; outcome: string; content: string }>(
      `SELECT role, parts->>'outcome' AS outcome, content FROM messages
        WHERE tool_call_id = 'call-1' AND role = 'tool'`,
    );
    expect(msg.rows).toHaveLength(1);
    expect(msg.rows[0].outcome).toBe("succeeded");
    expect(msg.rows[0].content).toContain("Buy milk");

    const approval = await db.query<{ status: string }>(
      "SELECT status FROM tool_approvals WHERE id = $1",
      [approvalId],
    );
    expect(approval.rows[0].status).toBe("consumed");
  });

  it("an unknown tool name returns tool_error and rolls the claim back", async () => {
    const seeded = await db.query<{ id: string }>(
      `INSERT INTO tool_approvals
        (user_id, conversation_id, tool_call_id, tool_name, parameters, parameters_hash,
         expires_at, status, approved_at)
        VALUES ($1, $2, 'call-x', 'teleport', '{}', m3_params_hash('{}'::jsonb),
                now() + interval '5 minutes', 'approved', now())
        RETURNING id`,
      [userA, conversationA],
    );
    await setTestUser(db, userA);
    const r = await callAs<{ result_code: string }>(
      db,
      "authenticated",
      "SELECT result_code FROM execute_approved_action($1)",
      [seeded.rows[0].id],
    );
    expect(r.rows[0].result_code).toBe("tool_error");
    const approval = await db.query<{ status: string; retry_count: number }>(
      "SELECT status, retry_count FROM tool_approvals WHERE id = $1",
      [seeded.rows[0].id],
    );
    expect(approval.rows[0].status).toBe("approved");
    expect(approval.rows[0].retry_count).toBe(0);
    const tasks = await db.query<{ n: string }>("SELECT count(*) AS n FROM tasks");
    expect(Number(tasks.rows[0].n)).toBe(0);
  });

  it("an over-length title fails the CHECK, returns tool_error and writes nothing", async () => {
    const approvalId = await proposeTask(
      JSON.stringify({ title: "x".repeat(300) }),
    );
    const r = await approveAndExecute(approvalId);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].result_code).toBe("tool_error");
    const approval = await db.query<{ status: string; retry_count: number }>(
      "SELECT status, retry_count FROM tool_approvals WHERE id = $1",
      [approvalId],
    );
    expect(approval.rows[0].status).toBe("approved");
    expect(approval.rows[0].retry_count).toBe(0);
    const tasks = await db.query<{ n: string }>("SELECT count(*) AS n FROM tasks");
    expect(Number(tasks.rows[0].n)).toBe(0);
    const log = await db.query<{ execution_status: string }>(
      "SELECT execution_status FROM action_logs WHERE approval_id = $1",
      [approvalId],
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].execution_status).toBe("pending");
  });
});
