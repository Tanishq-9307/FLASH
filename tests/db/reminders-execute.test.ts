// create_reminder branch tests (Phase 3): an approved reminder
// proposal inserts the row with the approval's user_id, updates the
// log and appends the tool message — all inside the same
// transaction as the claim. A past remind_at or an empty message
// fails as tool_error and rolls the claim back.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { callAs, createTestDb, createTestUser, setTestUser } from "./helpers";

describe("execute_approved_action create_reminder branch (Phase 3)", () => {
  let db: PGlite;
  let userA: string;
  let conversationA: string;

  const proposeReminder = async (params: string): Promise<string> => {
    const r = await callAs<{ approval_id: string }>(
      db,
      "service_role",
      "SELECT approval_id FROM create_pending_approval($1, $2, $3, $4, $5, $6)",
      [userA, conversationA, "call-1", "create_reminder", params, 300],
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
      result_payload: { reminder_id?: string; message?: string };
    }>(
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
    await db.query("DELETE FROM reminders");
    await db.query("DELETE FROM messages");
    await setTestUser(db, userA);
  });

  it("claim, reminder row, log and message all appear", async () => {
    const approvalId = await proposeReminder(
      JSON.stringify({
        message: "Submit the form",
        remind_at: "2999-11-26T03:30:00Z",
      }),
    );
    const r = await approveAndExecute(approvalId);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].result_code).toBe("claimed");
    const reminderId = r.rows[0].result_payload.reminder_id;
    expect(reminderId).toBeTruthy();

    const row = await db.query<{
      user_id: string;
      message: string;
      remind_at: Date | string;
      status: string;
      source: string;
    }>(
      "SELECT user_id, message, remind_at, status, source FROM reminders WHERE id = $1",
      [reminderId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].user_id).toBe(userA);
    expect(row.rows[0].message).toBe("Submit the form");
    expect(new Date(row.rows[0].remind_at).toISOString()).toBe(
      "2999-11-26T03:30:00.000Z",
    );
    expect(row.rows[0].status).toBe("pending");
    expect(row.rows[0].source).toBe("chat");

    const log = await db.query<{
      execution_status: string;
      result_payload: { reminder_id?: string };
    }>(
      "SELECT execution_status, result_payload FROM action_logs WHERE approval_id = $1",
      [approvalId],
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].execution_status).toBe("succeeded");
    expect(log.rows[0].result_payload.reminder_id).toBe(reminderId);

    const msg = await db.query<{ role: string; outcome: string; content: string }>(
      `SELECT role, parts->>'outcome' AS outcome, content FROM messages
        WHERE tool_call_id = 'call-1' AND role = 'tool'`,
    );
    expect(msg.rows).toHaveLength(1);
    expect(msg.rows[0].outcome).toBe("succeeded");
    expect(msg.rows[0].content).toContain("Submit the form");

    const approval = await db.query<{ status: string }>(
      "SELECT status FROM tool_approvals WHERE id = $1",
      [approvalId],
    );
    expect(approval.rows[0].status).toBe("consumed");
  });

  it("a past remind_at fails as tool_error and rolls the claim back", async () => {
    const approvalId = await proposeReminder(
      JSON.stringify({
        message: "Too late",
        remind_at: "2020-01-01T00:00:00Z",
      }),
    );
    const r = await approveAndExecute(approvalId);
    expect(r.rows[0].result_code).toBe("tool_error");
    const rows = await db.query("SELECT id FROM reminders");
    expect(rows.rows).toHaveLength(0);
    const approval = await db.query<{
      status: string;
      retry_count: number;
    }>("SELECT status, retry_count FROM tool_approvals WHERE id = $1", [
      approvalId,
    ]);
    expect(approval.rows[0].status).toBe("approved");
    expect(approval.rows[0].retry_count).toBe(0);
  });

  it("an empty message fails as tool_error", async () => {
    const approvalId = await proposeReminder(
      JSON.stringify({ message: "   ", remind_at: "2999-11-26T03:30:00Z" }),
    );
    const r = await approveAndExecute(approvalId);
    expect(r.rows[0].result_code).toBe("tool_error");
    const rows = await db.query("SELECT id FROM reminders");
    expect(rows.rows).toHaveLength(0);
  });

  it("create_reminder is an approval tool; create_task still works", async () => {
    const allowed = await db.query<{ ok: boolean }>(
      "SELECT m3_is_approval_tool('create_reminder') AS ok",
    );
    expect(allowed.rows[0].ok).toBe(true);
    const taskApproval = await callAs<{ approval_id: string }>(
      db,
      "service_role",
      "SELECT approval_id FROM create_pending_approval($1, $2, $3, $4, $5, $6)",
      [
        userA,
        conversationA,
        "call-2",
        "create_task",
        JSON.stringify({ title: "Still works" }),
        300,
      ],
    );
    await setTestUser(db, userA);
    await callAs(db, "authenticated", "SELECT approval_id FROM approve_action($1)", [
      taskApproval.rows[0].approval_id,
    ]);
    const r = await callAs<{ result_code: string }>(
      db,
      "authenticated",
      "SELECT result_code FROM execute_approved_action($1)",
      [taskApproval.rows[0].approval_id],
    );
    expect(r.rows[0].result_code).toBe("claimed");
    const tasks = await db.query<{ title: string }>("SELECT title FROM tasks");
    expect(tasks.rows.map((t) => t.title)).toContain("Still works");
  });
});
