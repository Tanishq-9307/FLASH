// M3-1a tests (DATABASE.md §3.7–3.9, §4, §6).
//
// The three approval-system tables exist with RLS on, the right CHECKs,
// the one-open-approval partial unique index, and the §4 privileges:
// clients may only SELECT tool_approvals and action_logs, while memories
// is fully owner-editable. Audit rows survive conversation deletion
// (covered in M3-1b); here the shape and the privilege matrix are proven.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { callAs, createTestDb, createTestUser, setTestUser } from "./helpers";

describe("M3-1a tables (memories, tool_approvals, action_logs)", () => {
  let db: PGlite;
  let userA: string;
  let userB: string;
  let conversationA: string;

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
    // Superuser deletes bypass RLS; logs first so the NO ACTION
    // approval foreign key never blocks the approval cleanup.
    await db.query("DELETE FROM action_logs");
    await db.query("DELETE FROM tool_approvals");
    await db.query("DELETE FROM memories");
  });

  it("RLS is enabled on all three tables", async () => {
    const r = await db.query<{ tablename: string; rowsecurity: boolean }>(
      `SELECT tablename, rowsecurity FROM pg_tables
        WHERE schemaname = 'public'
        AND tablename IN ('memories', 'tool_approvals', 'action_logs')`,
    );
    expect(r.rows).toHaveLength(3);
    for (const row of r.rows) expect(row.rowsecurity).toBe(true);
  });

  it("the one-open-approval partial unique index exists", async () => {
    const r = await db.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_one_open_approval'`,
    );
    expect(r.rows).toHaveLength(1);
    // Postgres normalises `IN ('pending','approved')` to `= ANY (ARRAY[...])`.
    expect(r.rows[0].indexdef).toMatch(/status = ANY \(ARRAY\['pending'::text, 'approved'::text\]\)/);
    expect(r.rows[0].indexdef).toMatch(/UNIQUE INDEX idx_one_open_approval/);
  });

  it("anon holds no privilege on any of the three tables", async () => {
    for (const table of ["memories", "tool_approvals", "action_logs"]) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const r = await db.query<{ ok: boolean }>(
          "SELECT has_table_privilege('anon', $1, $2) AS ok",
          [`public.${table}`, priv],
        );
        expect(r.rows[0].ok).toBe(false);
      }
    }
  });

  it("authenticated holds exactly the §4 privileges", async () => {
    const expected: Record<string, string[]> = {
      memories: ["SELECT", "INSERT", "UPDATE", "DELETE"],
      tool_approvals: ["SELECT"],
      action_logs: ["SELECT"],
    };
    for (const [table, allowed] of Object.entries(expected)) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const r = await db.query<{ ok: boolean }>(
          "SELECT has_table_privilege('authenticated', $1, $2) AS ok",
          [`public.${table}`, priv],
        );
        expect(r.rows[0].ok).toBe(allowed.includes(priv));
      }
    }
  });

  it("authenticated cannot insert, update, or delete tool_approvals or action_logs", async () => {
    await setTestUser(db, userA);
    const insertApproval = callAs(
      db,
      "authenticated",
      `INSERT INTO tool_approvals
        (user_id, conversation_id, tool_call_id, tool_name, parameters, parameters_hash, expires_at)
        VALUES ($1, $2, 'call-1', 'create_task', '{"title":"x"}', 'abc', now() + interval '5 minutes')`,
      [userA, conversationA],
    );
    await expect(insertApproval).rejects.toThrow(/permission denied/);

    const insertLog = callAs(
      db,
      "authenticated",
      `INSERT INTO action_logs
        (user_id, conversation_id, tool_call_id, tool_name, parameters, execution_status)
        VALUES ($1, $2, 'call-1', 'create_task', '{}', 'pending')`,
      [userA, conversationA],
    );
    await expect(insertLog).rejects.toThrow(/permission denied/);

    // Seed rows as superuser (bypasses RLS) so the UPDATE/DELETE
    // denials can be exercised against real rows.
    const approval = await db.query<{ id: string }>(
      `INSERT INTO tool_approvals
        (user_id, conversation_id, tool_call_id, tool_name, parameters, parameters_hash, expires_at)
        VALUES ($1, $2, 'call-2', 'create_task', '{"title":"x"}', 'abc', now() + interval '5 minutes')
        RETURNING id`,
      [userA, conversationA],
    );
    const approvalId = approval.rows[0].id;
    await expect(
      callAs(
        db,
        "authenticated",
        "UPDATE tool_approvals SET status = 'approved' WHERE id = $1",
        [approvalId],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      callAs(db, "authenticated", "DELETE FROM tool_approvals WHERE id = $1", [
        approvalId,
      ]),
    ).rejects.toThrow(/permission denied/);

    const log = await db.query<{ id: string }>(
      `INSERT INTO action_logs
        (user_id, conversation_id, tool_call_id, tool_name, parameters, execution_status)
        VALUES ($1, $2, 'call-3', 'create_task', '{}', 'pending')
        RETURNING id`,
      [userA, conversationA],
    );
    const logId = log.rows[0].id;
    await expect(
      callAs(
        db,
        "authenticated",
        "UPDATE action_logs SET execution_status = 'succeeded' WHERE id = $1",
        [logId],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      callAs(db, "authenticated", "DELETE FROM action_logs WHERE id = $1", [
        logId,
      ]),
    ).rejects.toThrow(/permission denied/);
  });

  it("the partial index refuses a second open approval in one conversation", async () => {
    await db.query(
      `INSERT INTO tool_approvals
        (user_id, conversation_id, tool_call_id, tool_name, parameters, parameters_hash, expires_at)
        VALUES ($1, $2, 'call-idx-1', 'create_task', '{"title":"a"}', 'aa', now() + interval '5 minutes')`,
      [userA, conversationA],
    );
    await expect(
      db.query(
        `INSERT INTO tool_approvals
          (user_id, conversation_id, tool_call_id, tool_name, parameters, parameters_hash, expires_at)
          VALUES ($1, $2, 'call-idx-2', 'save_memory', '{"fact":"b"}', 'bb', now() + interval '5 minutes')`,
        [userA, conversationA],
      ),
    ).rejects.toThrow(/idx_one_open_approval/);
  });

  it("tool_approvals CHECKs refuse bad status, retry count, and consumed without a timestamp", async () => {
    const base = [
      userA,
      conversationA,
      "call-chk",
      "create_task",
      '{"title":"x"}',
      "abc",
    ];
    await expect(
      db.query(
        `INSERT INTO tool_approvals
          (user_id, conversation_id, tool_call_id, tool_name, parameters, parameters_hash, status, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, 'bogus', now() + interval '5 minutes')`,
        base,
      ),
    ).rejects.toThrow(/check constraint/i);
    await expect(
      db.query(
        `INSERT INTO tool_approvals
          (user_id, conversation_id, tool_call_id, tool_name, parameters, parameters_hash, retry_count, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, 4, now() + interval '5 minutes')`,
        base,
      ),
    ).rejects.toThrow(/check constraint/i);
    await expect(
      db.query(
        `INSERT INTO tool_approvals
          (user_id, conversation_id, tool_call_id, tool_name, parameters, parameters_hash, status, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, 'consumed', now() + interval '5 minutes')`,
        base,
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("memories: owner CRUD works, empty or over-long facts are refused, user B sees none of user A's rows", async () => {
    await setTestUser(db, userA);
    const inserted = await callAs<{ id: string }>(
      db,
      "authenticated",
      "INSERT INTO memories (fact) VALUES ('I prefer British English') RETURNING id",
    );
    expect(inserted.rows).toHaveLength(1);
    const memoryId = inserted.rows[0].id;

    await expect(
      callAs(db, "authenticated", "INSERT INTO memories (fact) VALUES ('   ')"),
    ).rejects.toThrow(/check constraint/i);
    await expect(
      callAs(db, "authenticated", "INSERT INTO memories (fact) VALUES ($1)", [
        "x".repeat(10001),
      ]),
    ).rejects.toThrow(/check constraint/i);

    await setTestUser(db, userB);
    const seenByB = await callAs<{ id: string }>(
      db,
      "authenticated",
      "SELECT id FROM memories",
    );
    expect(seenByB.rows).toHaveLength(0);
    const hijack = await callAs<{ id: string }>(
      db,
      "authenticated",
      "UPDATE memories SET fact = 'hijacked' WHERE id = $1 RETURNING id",
      [memoryId],
    );
    expect(hijack.rows).toHaveLength(0);
    const stillThere = await db.query<{ fact: string }>(
      "SELECT fact FROM memories WHERE id = $1",
      [memoryId],
    );
    expect(stillThere.rows[0].fact).toBe("I prefer British English");

    await setTestUser(db, userA);
    const deleted = await callAs<{ id: string }>(
      db,
      "authenticated",
      "DELETE FROM memories WHERE id = $1 RETURNING id",
      [memoryId],
    );
    expect(deleted.rows).toHaveLength(1);
  });
});
