// M3-1b tests (DATABASE.md §3.3, §3.8, §3.9, §6).
//
// The approval and audit tables are append-only history: immutable
// columns cannot change, conversation_id may only become NULL, a final
// status never changes again, and outcome_delivered_at is set once. The
// conversation delete guard refuses a delete while an open (unexpired)
// approval exists, but never blocks account deletion.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  callAs,
  createTestDb,
  createTestUser,
  deleteTestUser,
  setTestUser,
} from "./helpers";

describe("M3-1b immutability triggers and delete guard", () => {
  let db: PGlite;
  let userA: string;
  let conversationA: string;
  let conversationA2: string;

  /** Seed one approval (superuser: bypasses RLS) and return its id. */
  async function seedApproval(
    userId: string,
    conversationId: string | null,
    status: string,
    expiresInMinutes: number,
  ): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO tool_approvals
        (user_id, conversation_id, tool_call_id, tool_name, parameters, parameters_hash, status, expires_at)
        VALUES ($1, $2, $3, 'create_task', '{"title":"x"}', 'abc', $4, now() + ($5 || ' minutes')::interval)
        RETURNING id`,
      [userId, conversationId, `call-${randomUUID()}`, status, String(expiresInMinutes)],
    );
    return r.rows[0].id;
  }

  /** Seed one log row (superuser) and return its id. */
  async function seedLog(
    userId: string,
    conversationId: string | null,
    approvalId: string | null,
  ): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO action_logs
        (user_id, conversation_id, approval_id, tool_call_id, tool_name, parameters, execution_status)
        VALUES ($1, $2, $3, $4, 'create_task', '{}', 'pending')
        RETURNING id`,
      [userId, conversationId, approvalId, `call-${randomUUID()}`],
    );
    return r.rows[0].id;
  }

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
    const a2 = await callAs<{ id: string }>(
      db,
      "authenticated",
      "INSERT INTO conversations (title) VALUES ('A2') RETURNING id",
    );
    conversationA2 = a2.rows[0].id;
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM action_logs");
    await db.query("DELETE FROM tool_approvals");
    await db.query("DELETE FROM messages");
  });

  it("immutable columns on tool_approvals cannot change", async () => {
    const id = await seedApproval(userA, conversationA, "pending", 5);
    for (const [column, value] of [
      ["parameters", `'{"title":"forged"}'`],
      ["parameters_hash", `'deadbeef'`],
      ["tool_name", `'save_memory'`],
      ["tool_call_id", `'call-forged'`],
      ["user_id", `'00000000-0000-0000-0000-000000000000'`],
      ["expires_at", `now() + interval '1 hour'`],
      ["created_at", `now()`],
    ] as const) {
      await expect(
        db.query(`UPDATE tool_approvals SET ${column} = ${value} WHERE id = $1`, [id]),
      ).rejects.toThrow(/immutable columns cannot change/);
    }
    // A final status never changes again.
    const done = await seedApproval(userA, conversationA2, "rejected", 5);
    await expect(
      db.query("UPDATE tool_approvals SET status = 'pending' WHERE id = $1", [done]),
    ).rejects.toThrow(/final status rejected cannot change/);
    // outcome_delivered_at is set once.
    await db.query(
      "UPDATE tool_approvals SET outcome_delivered_at = now() WHERE id = $1",
      [done],
    );
    await expect(
      db.query(
        "UPDATE tool_approvals SET outcome_delivered_at = now() + interval '1 hour' WHERE id = $1",
        [done],
      ),
    ).rejects.toThrow(/outcome_delivered_at is set once/);
    // Positive controls: a non-final status change and a retry_count bump
    // are allowed (the functions rely on them).
    await expect(
      db.query("UPDATE tool_approvals SET status = 'approved' WHERE id = $1", [id]),
    ).resolves.toBeDefined();
    await expect(
      db.query("UPDATE tool_approvals SET retry_count = 1 WHERE id = $1", [id]),
    ).resolves.toBeDefined();
  });

  it("immutable columns on action_logs cannot change", async () => {
    const id = await seedLog(userA, conversationA, null);
    for (const [column, value] of [
      ["parameters", `'{"forged":true}'`],
      ["tool_name", `'save_memory'`],
      ["tool_call_id", `'call-forged'`],
      ["user_id", `'00000000-0000-0000-0000-000000000000'`],
      ["approval_id", `gen_random_uuid()`],
      ["created_at", `now()`],
    ] as const) {
      await expect(
        db.query(`UPDATE action_logs SET ${column} = ${value} WHERE id = $1`, [id]),
      ).rejects.toThrow(/immutable columns cannot change/);
    }
    // Positive controls: the functions update these two columns.
    await expect(
      db.query(
        "UPDATE action_logs SET execution_status = 'succeeded', result_payload = '{\"ok\":true}' WHERE id = $1",
        [id],
      ),
    ).resolves.toBeDefined();
  });

  it("conversation_id may become NULL but never another value", async () => {
    const approvalId = await seedApproval(userA, conversationA, "pending", 5);
    const logId = await seedLog(userA, conversationA, approvalId);
    await expect(
      db.query(
        "UPDATE tool_approvals SET conversation_id = $1 WHERE id = $2",
        [conversationA2, approvalId],
      ),
    ).rejects.toThrow(/conversation_id may only become NULL/);
    await expect(
      db.query(
        "UPDATE action_logs SET conversation_id = $1 WHERE id = $2",
        [conversationA2, logId],
      ),
    ).rejects.toThrow(/conversation_id may only become NULL/);
    // To NULL is allowed on both tables.
    await expect(
      db.query("UPDATE tool_approvals SET conversation_id = NULL WHERE id = $1", [
        approvalId,
      ]),
    ).resolves.toBeDefined();
    await expect(
      db.query("UPDATE action_logs SET conversation_id = NULL WHERE id = $1", [logId]),
    ).resolves.toBeDefined();
  });

  it("a conversation with an open approval cannot be deleted", async () => {
    await seedApproval(userA, conversationA, "pending", 5);
    await setTestUser(db, userA);
    await expect(
      callAs(db, "authenticated", "DELETE FROM conversations WHERE id = $1", [
        conversationA,
      ]),
    ).rejects.toThrow(/conversation_has_open_approval/);
    // The conversation is still there.
    const still = await db.query("SELECT id FROM conversations WHERE id = $1", [
      conversationA,
    ]);
    expect(still.rows).toHaveLength(1);
  });

  it("an overdue open approval does not block deletion", async () => {
    await seedApproval(userA, conversationA, "pending", -5);
    await setTestUser(db, userA);
    await expect(
      callAs(
        db,
        "authenticated",
        "DELETE FROM conversations WHERE id = $1 RETURNING id",
        [conversationA],
      ),
    ).resolves.toMatchObject({ rows: [{ id: conversationA }] });
    // Recreate it for the remaining tests.
    await db.query(
      "INSERT INTO conversations (id, user_id, title) VALUES ($1, $2, 'A')",
      [conversationA, userA],
    );
  });

  it("deleting a conversation without an open approval keeps approvals and logs with null conversation_id", async () => {
    const approvalId = await seedApproval(userA, conversationA, "rejected", 5);
    const logId = await seedLog(userA, conversationA, approvalId);
    await setTestUser(db, userA);
    await callAs(
      db,
      "authenticated",
      "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', 'hello')",
      [conversationA],
    );
    const deleted = await callAs<{ id: string }>(
      db,
      "authenticated",
      "DELETE FROM conversations WHERE id = $1 RETURNING id",
      [conversationA],
    );
    expect(deleted.rows).toHaveLength(1);
    const approval = await db.query<{ conversation_id: string | null }>(
      "SELECT conversation_id FROM tool_approvals WHERE id = $1",
      [approvalId],
    );
    expect(approval.rows).toHaveLength(1);
    expect(approval.rows[0].conversation_id).toBeNull();
    const log = await db.query<{ conversation_id: string | null }>(
      "SELECT conversation_id FROM action_logs WHERE id = $1",
      [logId],
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].conversation_id).toBeNull();
    // Messages are gone with the conversation (cascade).
    const messages = await db.query("SELECT id FROM messages");
    expect(messages.rows).toHaveLength(0);
    // Recreate the conversation for the remaining tests.
    await db.query(
      "INSERT INTO conversations (id, user_id, title) VALUES ($1, $2, 'A')",
      [conversationA, userA],
    );
  });

  it("deleting the test user succeeds and removes all of their rows (NO ACTION choice)", async () => {
    const userC = await createTestUser(db);
    await setTestUser(db, userC);
    const conv = await callAs<{ id: string }>(
      db,
      "authenticated",
      "INSERT INTO conversations (title) VALUES ('C') RETURNING id",
    );
    const convC = conv.rows[0].id;
    const approvalId = await seedApproval(userC, convC, "pending", 5);
    await seedLog(userC, convC, approvalId);
    await expect(deleteTestUser(db, userC)).resolves.toBeUndefined();
    for (const [table, column] of [
      ["conversations", "user_id"],
      ["tool_approvals", "user_id"],
      ["action_logs", "user_id"],
      ["memories", "user_id"],
    ] as const) {
      const left = await db.query(`SELECT id FROM ${table} WHERE ${column} = $1`, [
        userC,
      ]);
      expect(left.rows).toHaveLength(0);
    }
  });
});
