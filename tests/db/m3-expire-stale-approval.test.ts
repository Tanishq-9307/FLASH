// M3-6 tests (ARCHITECTURE.md §5.1, §5.4, DATABASE.md §5.1, §6).
//
// expire_stale_approval marks one overdue approval expired (and settles
// its log and writes the tool message, via the m3_expire helper), and
// returns no row when the approval is not overdue. Service role only.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { callAs, createTestDb, createTestUser, setTestUser } from "./helpers";

describe("expire_stale_approval (M3-6)", () => {
  let db: PGlite;
  let userA: string;
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

  const expire = (role: "anon" | "authenticated" | "service_role", approvalId: string) =>
    callAs<{ approval_id: string; approval_status: string }>(
      db,
      role,
      "SELECT approval_id, approval_status FROM expire_stale_approval($1, $2)",
      [userA, approvalId],
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
    await db.query("DELETE FROM tool_approvals");
    await db.query("DELETE FROM messages");
    await setTestUser(db, userA);
  });

  it("a short-TTL approval expires after the window, and approve then fails", async () => {
    const approvalId = await propose(2);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    // The approval is now overdue: approve refuses it.
    const approved = await callAs<{ approval_id: string }>(
      db,
      "authenticated",
      "SELECT approval_id FROM approve_action($1)",
      [approvalId],
    );
    expect(approved.rows).toHaveLength(0);
    // Expire marks it expired, settles the log, writes the message.
    const r = await expire("service_role", approvalId);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].approval_status).toBe("expired");
    const row = await db.query<{ status: string }>(
      "SELECT status FROM tool_approvals WHERE id = $1",
      [approvalId],
    );
    expect(row.rows[0].status).toBe("expired");
    const log = await db.query<{ execution_status: string }>(
      "SELECT execution_status FROM action_logs WHERE approval_id = $1",
      [approvalId],
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].execution_status).toBe("not_executed");
    const msg = await db.query<{ role: string; outcome: string }>(
      `SELECT role, parts->>'outcome' AS outcome FROM messages
        WHERE tool_call_id = 'call-1' AND role = 'tool'`,
    );
    expect(msg.rows).toHaveLength(1);
    expect(msg.rows[0].outcome).toBe("expired");
  });

  it("a not-yet-due approval is untouched", async () => {
    const approvalId = await propose(300);
    const r = await expire("service_role", approvalId);
    expect(r.rows).toHaveLength(0);
    const row = await db.query<{ status: string }>(
      "SELECT status FROM tool_approvals WHERE id = $1",
      [approvalId],
    );
    expect(row.rows[0].status).toBe("pending");
    const log = await db.query<{ execution_status: string }>(
      "SELECT execution_status FROM action_logs WHERE approval_id = $1",
      [approvalId],
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].execution_status).toBe("pending");
  });

  it("a second call on an expired approval is a no-op", async () => {
    const approvalId = await propose(2);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const first = await expire("service_role", approvalId);
    expect(first.rows).toHaveLength(1);
    const second = await expire("service_role", approvalId);
    expect(second.rows).toHaveLength(0);
    // Exactly one tool message: the expiry was recorded once.
    const msg = await db.query<{ id: string }>(
      `SELECT id FROM messages WHERE tool_call_id = 'call-1' AND role = 'tool'`,
    );
    expect(msg.rows).toHaveLength(1);
  });

  it("anon and authenticated are denied", async () => {
    const approvalId = await propose(2);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await expect(expire("anon", approvalId)).rejects.toThrow(/permission denied/);
    await expect(expire("authenticated", approvalId)).rejects.toThrow(
      /permission denied/,
    );
  });
});
