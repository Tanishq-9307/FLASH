// M3-2 tests (DATABASE.md §5.1, §5.2, §6).
//
// create_pending_approval records a proposal with a Postgres-computed
// hash and expiry, refuses a second live proposal (including racing
// ones), expires an overdue open approval and replaces it, and is
// callable only by service_role. Unknown tools and out-of-range TTLs are
// refused outright.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { callAs, createTestDb, createTestUser, setTestUser } from "./helpers";

type ProposalRow = {
  result_code: string;
  approval_id: string | null;
  log_id: string | null;
};

describe("create_pending_approval (M3-2)", () => {
  let db: PGlite;
  let userA: string;
  let conversationA: string;

  const propose = (
    role: "anon" | "authenticated" | "service_role",
    tool = "create_task",
    params: unknown = { title: "Buy milk" },
    ttl = 300,
  ) =>
    callAs<ProposalRow>(
      db,
      role,
      "SELECT * FROM create_pending_approval($1, $2, $3, $4, $5, $6)",
      [userA, conversationA, "call-1", tool, JSON.stringify(params), ttl],
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
  });

  it("hash equals sha256 of the stored JSONB text and expiry matches the TTL", async () => {
    const r = await propose("service_role");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].result_code).toBe("created");
    const approvalId = r.rows[0].approval_id;
    expect(approvalId).toBeTruthy();
    expect(r.rows[0].log_id).toBeTruthy();

    const row = await db.query<{
      parameters_hash: string;
      recomputed: string;
      seconds_left: number;
    }>(
      `SELECT parameters_hash,
              encode(sha256(convert_to(parameters::text, 'UTF8')), 'hex') AS recomputed,
              EXTRACT(EPOCH FROM (expires_at - now())) AS seconds_left
         FROM tool_approvals WHERE id = $1`,
      [approvalId],
    );
    expect(row.rows[0].parameters_hash).toBe(row.rows[0].recomputed);
    // TTL was 300 seconds; allow a few seconds of test runtime.
    // (PGlite returns EXTRACT(EPOCH ...) as a string.)
    const secondsLeft = Number(row.rows[0].seconds_left);
    expect(secondsLeft).toBeGreaterThan(290);
    expect(secondsLeft).toBeLessThanOrEqual(300);

    // The pending log exists and belongs to the approval.
    const log = await db.query<{ approval_id: string; execution_status: string }>(
      "SELECT approval_id, execution_status FROM action_logs WHERE id = $1",
      [r.rows[0].log_id],
    );
    expect(log.rows).toEqual([
      { approval_id: approvalId, execution_status: "pending" },
    ]);
  });

  it("a second proposal in the same conversation is refused", async () => {
    const first = await propose("service_role");
    expect(first.rows[0].result_code).toBe("created");
    const second = await propose("service_role", "save_memory", { fact: "x" });
    expect(second.rows).toEqual([
      { result_code: "open_approval_exists", approval_id: null, log_id: null },
    ]);
    const count = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM tool_approvals",
    );
    expect(count.rows[0].n).toBe("1");
  });

  it("two racing proposals give exactly one created and one refused", async () => {
    // PGlite is a single connection, so the calls serialise; the
    // behaviour that matters — one wins, the other is refused, never
    // two approvals — is what this proves. The unique_violation catch is
    // defence in depth for real Postgres.
    await db.query("SET ROLE service_role");
    try {
      const [a, b] = await Promise.all([
        db.query<ProposalRow>(
          "SELECT * FROM create_pending_approval($1, $2, $3, $4, $5, $6)",
          [userA, conversationA, "call-race-1", "create_task", '{"title":"a"}', 300],
        ),
        db.query<ProposalRow>(
          "SELECT * FROM create_pending_approval($1, $2, $3, $4, $5, $6)",
          [userA, conversationA, "call-race-2", "save_memory", '{"fact":"b"}', 300],
        ),
      ]);
      const codes = [a.rows[0].result_code, b.rows[0].result_code].sort();
      expect(codes).toEqual(["created", "open_approval_exists"]);
    } finally {
      await db.query("RESET ROLE");
    }
    const count = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM tool_approvals",
    );
    expect(count.rows[0].n).toBe("1");
  });

  it("an overdue open approval is expired and replaced", async () => {
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
    const oldId = old.rows[0].id;
    await db.query(
      `INSERT INTO action_logs
        (user_id, conversation_id, approval_id, tool_call_id, tool_name, parameters, execution_status)
        VALUES ($1, $2, $3, 'call-old', 'create_task', '{"title":"old"}', 'pending')`,
      [userA, conversationA, oldId],
    );

    const r = await propose("service_role");
    expect(r.rows[0].result_code).toBe("created");
    expect(r.rows[0].approval_id).not.toBe(oldId);

    const expired = await db.query<{ status: string }>(
      "SELECT status FROM tool_approvals WHERE id = $1",
      [oldId],
    );
    expect(expired.rows[0].status).toBe("expired");
    const log = await db.query<{ execution_status: string; result_payload: unknown }>(
      "SELECT execution_status, result_payload FROM action_logs WHERE approval_id = $1 AND execution_status <> 'pending'",
      [oldId],
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].execution_status).toBe("not_executed");
    // The tool message tells the conversation the old proposal expired.
    const message = await db.query<{ role: string; content: string }>(
      "SELECT role, content FROM messages WHERE tool_call_id = 'call-old'",
    );
    expect(message.rows).toHaveLength(1);
    expect(message.rows[0].role).toBe("tool");
    expect(message.rows[0].content).toMatch(/expired/);
  });

  it("anon and authenticated are denied", async () => {
    await expect(propose("anon")).rejects.toThrow(/permission denied/);
    await expect(propose("authenticated")).rejects.toThrow(/permission denied/);
  });

  it("unknown tools and out-of-range TTLs are refused", async () => {
    await expect(
      propose("service_role", "delete_everything"),
    ).rejects.toThrow(/unknown tool/);
    await expect(propose("service_role", "create_task", { title: "x" }, 0)).rejects.toThrow(
      /TTL must be 1\.\.3600/,
    );
    await expect(
      propose("service_role", "create_task", { title: "x" }, 3601),
    ).rejects.toThrow(/TTL must be 1\.\.3600/);
    const count = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM tool_approvals",
    );
    expect(count.rows[0].n).toBe("0");
  });
});
