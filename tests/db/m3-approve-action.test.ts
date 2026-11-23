// M3-4 tests (ARCHITECTURE.md §5.4, DATABASE.md §5.1, §6).
//
// approve_action moves a pending approval to approved exactly once and
// only before expiry, only for its owner, and is callable only by an
// authenticated user.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { callAs, createTestDb, createTestUser, setTestUser } from "./helpers";

describe("approve_action (M3-4)", () => {
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

  const approve = (role: "anon" | "authenticated", approvalId: string) =>
    callAs<{ approval_id: string; approval_status: string }>(
      db,
      role,
      "SELECT approval_id, approval_status FROM approve_action($1)",
      [approvalId],
    );

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

  it("pending to approved works and stamps approved_at", async () => {
    const approvalId = await propose();
    const r = await approve("authenticated", approvalId);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].approval_status).toBe("approved");
    const row = await db.query<{ status: string; approved_at: string | null }>(
      "SELECT status, approved_at FROM tool_approvals WHERE id = $1",
      [approvalId],
    );
    expect(row.rows[0].status).toBe("approved");
    expect(row.rows[0].approved_at).toBeTruthy();
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
    const r = await approve("authenticated", old.rows[0].id);
    expect(r.rows).toHaveLength(0);
    const row = await db.query<{ status: string }>(
      "SELECT status FROM tool_approvals WHERE id = $1",
      [old.rows[0].id],
    );
    expect(row.rows[0].status).toBe("pending");
  });

  it("another user's approval is refused", async () => {
    const approvalId = await propose();
    await setTestUser(db, userB);
    const r = await approve("authenticated", approvalId);
    expect(r.rows).toHaveLength(0);
    const row = await db.query<{ status: string }>(
      "SELECT status FROM tool_approvals WHERE id = $1",
      [approvalId],
    );
    expect(row.rows[0].status).toBe("pending");
  });

  it("an already approved or rejected approval is refused", async () => {
    const approvalId = await propose();
    const first = await approve("authenticated", approvalId);
    expect(first.rows).toHaveLength(1);
    const second = await approve("authenticated", approvalId);
    expect(second.rows).toHaveLength(0);

    const rejected = await db.query<{ id: string }>(
      `INSERT INTO tool_approvals
        (user_id, conversation_id, tool_call_id, tool_name, parameters, parameters_hash, expires_at, status)
        VALUES ($1, $2, 'call-rej', 'create_task', '{"title":"rej"}',
                m3_params_hash('{"title":"rej"}'::jsonb), now() + interval '5 minutes', 'rejected')
        RETURNING id`,
      [userA, conversationA],
    );
    const afterReject = await approve("authenticated", rejected.rows[0].id);
    expect(afterReject.rows).toHaveLength(0);
  });

  it("anon is denied", async () => {
    const approvalId = await propose();
    await expect(approve("anon", approvalId)).rejects.toThrow(/permission denied/);
  });
});
