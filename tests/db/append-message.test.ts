// append_message tests (M2-4, DATABASE.md §5.1, §6).
//
// The only way to write assistant and system messages. Service role
// succeeds; anon and authenticated get "permission denied"; the `user`
// and `tool` roles are rejected; a message cannot be filed under another
// user's conversation (the composite foreign key refuses it).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { callAs, createTestDb, createTestUser, setTestUser } from "./helpers";

describe("append_message (M2-4)", () => {
  let db: PGlite;
  let userA: string;
  let userB: string;
  let conversationA: string;
  let conversationB: string;

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
    await setTestUser(db, userB);
    const b = await callAs<{ id: string }>(
      db,
      "authenticated",
      "INSERT INTO conversations (title) VALUES ('B') RETURNING id",
    );
    conversationB = b.rows[0].id;
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM messages");
  });

  const append = (role: "anon" | "authenticated" | "service_role") =>
    callAs<{ append_message: string }>(
      db,
      role,
      "SELECT append_message($1, $2, $3, $4, $5, $6) AS append_message",
      [userA, conversationA, "assistant", "Hello", null, null],
    );

  it("service_role succeeds and the row is in messages", async () => {
    const r = await append("service_role");
    expect(r.rows).toHaveLength(1);
    const id = r.rows[0].append_message;
    expect(typeof id).toBe("string");
    const row = await db.query<{ role: string; content: string }>(
      "SELECT role, content FROM messages WHERE id = $1",
      [id],
    );
    expect(row.rows).toEqual([{ role: "assistant", content: "Hello" }]);

    const sys = await callAs<{ append_message: string }>(
      db,
      "service_role",
      "SELECT append_message($1, $2, 'system', 'Notice', NULL, NULL) AS append_message",
      [userA, conversationA],
    );
    expect(sys.rows).toHaveLength(1);
  });

  it("anon and authenticated get permission denied", async () => {
    await expect(append("anon")).rejects.toThrow(/permission denied/);
    await expect(append("authenticated")).rejects.toThrow(/permission denied/);
  });

  it.each(["user", "tool"])("role %s is rejected", async (role) => {
    await expect(
      callAs(
        db,
        "service_role",
        "SELECT append_message($1, $2, $3, 'x', NULL, NULL)",
        [userA, conversationA, role],
      ),
    ).rejects.toThrow(/role must be assistant or system/);
  });

  it("inserting into another user's conversation fails", async () => {
    await expect(
      callAs(
        db,
        "service_role",
        "SELECT append_message($1, $2, 'assistant', 'x', NULL, NULL)",
        [userA, conversationB],
      ),
    ).rejects.toThrow(/violates foreign key constraint/);
  });

  it("assistant rows may carry parts (incomplete marker, tool calls)", async () => {
    const r = await callAs<{ append_message: string }>(
      db,
      "service_role",
      "SELECT append_message($1, $2, 'assistant', 'Partial…', '{\"incomplete\": true}'::jsonb, NULL) AS append_message",
      [userA, conversationA],
    );
    const row = await db.query<{ parts: { incomplete?: boolean } }>(
      "SELECT parts FROM messages WHERE id = $1",
      [r.rows[0].append_message],
    );
    expect(row.rows[0].parts).toEqual({ incomplete: true });
  });
});
