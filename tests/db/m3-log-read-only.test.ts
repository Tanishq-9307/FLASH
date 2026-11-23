// M3-3 tests (DATABASE.md §5.1, §6).
//
// log_read_only_action writes the audit row for a read-only tool call
// (approval_id stays NULL), refuses any status other than succeeded or
// failed, refuses state-changing tool names, and is callable only by
// service_role.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { callAs, createTestDb, createTestUser, setTestUser } from "./helpers";

describe("log_read_only_action (M3-3)", () => {
  let db: PGlite;
  let userA: string;
  let conversationA: string;

  const log = (
    role: "anon" | "authenticated" | "service_role",
    tool = "get_tasks",
    status = "succeeded",
  ) =>
    callAs<{ log_read_only_action: string }>(
      db,
      role,
      "SELECT log_read_only_action($1, $2, $3, $4, $5, $6, $7)",
      [
        userA,
        conversationA,
        "call-1",
        tool,
        JSON.stringify({}),
        status,
        JSON.stringify({ tasks: [] }),
      ],
    );

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
  });

  it("a valid row is created with approval_id NULL", async () => {
    const r = await log("service_role");
    expect(r.rows).toHaveLength(1);
    const logId = r.rows[0].log_read_only_action;
    expect(logId).toBeTruthy();

    const row = await db.query<{
      approval_id: string | null;
      execution_status: string;
      result_payload: unknown;
      tool_name: string;
    }>(
      "SELECT approval_id, execution_status, result_payload, tool_name FROM action_logs WHERE id = $1",
      [logId],
    );
    expect(row.rows).toEqual([
      {
        approval_id: null,
        execution_status: "succeeded",
        result_payload: { tasks: [] },
        tool_name: "get_tasks",
      },
    ]);
  });

  it("a failed read is logged with status failed", async () => {
    const r = await log("service_role", "get_tasks", "failed");
    expect(r.rows).toHaveLength(1);
    const row = await db.query<{ execution_status: string }>(
      "SELECT execution_status FROM action_logs WHERE id = $1",
      [r.rows[0].log_read_only_action],
    );
    expect(row.rows[0].execution_status).toBe("failed");
  });

  it("any other status is rejected and writes nothing", async () => {
    await expect(log("service_role", "get_tasks", "pending")).rejects.toThrow(
      /status must be succeeded or failed/,
    );
    const count = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM action_logs",
    );
    expect(count.rows[0].n).toBe("0");
  });

  it("a state-changing tool name is refused and writes nothing", async () => {
    await expect(log("service_role", "create_task")).rejects.toThrow(
      /must go through approvals/,
    );
    await expect(log("service_role", "save_memory")).rejects.toThrow(
      /must go through approvals/,
    );
    const count = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM action_logs",
    );
    expect(count.rows[0].n).toBe("0");
  });

  it("anon and authenticated are denied", async () => {
    await expect(log("anon")).rejects.toThrow(/permission denied/);
    await expect(log("authenticated")).rejects.toThrow(/permission denied/);
  });
});
