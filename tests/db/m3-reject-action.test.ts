// M3-5 tests (ARCHITECTURE.md §5.4, §5.9, DATABASE.md §5.1, §6).
//
// reject_action moves an approval from `pending` or `approved` to
// `rejected` exactly once and only before expiry, only for its owner,
// and is callable only by an authenticated user. On success the pending
// log is settled as `not_executed` and a tool message is written.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { callAs, createTestDb, createTestUser, setTestUser } from "./helpers";

describe("reject_action (M3-5)", () => {
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

  const reject = (role: "anon" | "authenticated", approvalId: string) =>
    callAs<{ approval_id: string; approval_status: string }>(
      db,
      role,
      "SELECT approval_id, approval_status FROM reject_action($1)",
      [approvalId],
    );

  /** The pending log and the tool message for one approval. */
  const logAndMessage = async (approvalId: string) => {
    const log = await db.query<{ execution_status: string }>(
      "SELECT execution_status FROM action_logs WHERE approval_id = $1",
      [approvalId],
    );
    const msg = await db.query<{ role: string; outcome: string }>(
      `SELECT role, parts->>'outcome' AS outcome FROM messages
        WHERE tool_call_id = 'call-1' AND role = 'tool'`,
    );
    return { log: log.rows, msg: msg.rows };
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

  it("pending to rejected works, settles the log and writes the tool message", async () => {
    const approvalId = await propose();
    const r = await reject("authenticated", approvalId);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].approval_status).toBe("rejected");
    const row = await db.query<{ status: string }>(
      "SELECT status FROM tool_approvals WHERE id = $1",
      [approvalId],
    );
    expect(row.rows[0].status).toBe("rejected");
    const { log, msg } = await logAndMessage(approvalId);
    expect(log).toHaveLength(1);
    expect(log[0].execution_status).toBe("not_executed");
    expect(msg).toHaveLength(1);
    expect(msg[0].outcome).toBe("rejected");
  });

  it("approved to rejected works, settles the log and writes the tool message", async () => {
    const approvalId = await propose();
    const first = await approve(approvalId);
    expect(first.rows).toHaveLength(1);
    const r = await reject("authenticated", approvalId);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].approval_status).toBe("rejected");
    const { log, msg } = await logAndMessage(approvalId);
    expect(log).toHaveLength(1);
    expect(log[0].execution_status).toBe("not_executed");
    expect(msg).toHaveLength(1);
    expect(msg[0].outcome).toBe("rejected");
  });

  it("an expired approval is refused", async () => {
    // Seed an overdue pending approval directly (the immutability
    // trigger blocks UPDATEs to expires_at, so the row is inserted
    // overdue), with its pending log.
    const old = await db.query<{ id: string }>(
      `INSERT INTO tool_approvals
        (user_id, conversation_id, tool_call_id, tool_name, parameters, parameters_hash, expires_at)
        VALUES ($1, $2, 'call-old', 'create_task', '{"title":"old"}',
                m3_params_hash('{"title":"old"}'::jsonb), now() - interval '1 minute')
        RETURNING id`,
      [userA, conversationA],
    );
    const r = await reject("authenticated", old.rows[0].id);
    expect(r.rows).toHaveLength(0);
    const row = await db.query<{ status: string }>(
      "SELECT status FROM tool_approvals WHERE id = $1",
      [old.rows[0].id],
    );
    expect(row.rows[0].status).toBe("pending");
  });

  it("a consumed approval is refused", async () => {
    const done = await db.query<{ id: string }>(
      `INSERT INTO tool_approvals
        (user_id, conversation_id, tool_call_id, tool_name, parameters, parameters_hash, expires_at, status, consumed_at)
        VALUES ($1, $2, 'call-done', 'create_task', '{"title":"done"}',
                m3_params_hash('{"title":"done"}'::jsonb), now() + interval '5 minutes', 'consumed', now())
        RETURNING id`,
      [userA, conversationA],
    );
    const r = await reject("authenticated", done.rows[0].id);
    expect(r.rows).toHaveLength(0);
    const row = await db.query<{ status: string }>(
      "SELECT status FROM tool_approvals WHERE id = $1",
      [done.rows[0].id],
    );
    expect(row.rows[0].status).toBe("consumed");
  });

  it("another user's approval is refused", async () => {
    const approvalId = await propose();
    await setTestUser(db, userB);
    const r = await reject("authenticated", approvalId);
    expect(r.rows).toHaveLength(0);
    const row = await db.query<{ status: string }>(
      "SELECT status FROM tool_approvals WHERE id = $1",
      [approvalId],
    );
    expect(row.rows[0].status).toBe("pending");
  });

  it("anon is denied", async () => {
    const approvalId = await propose();
    await expect(reject("anon", approvalId)).rejects.toThrow(/permission denied/);
  });
});
