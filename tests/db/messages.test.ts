// Message-integrity tests (M2-2, DATABASE.md §3.4, §6).
//
// The client may insert only plain user messages (role = 'user', parts
// NULL, tool_call_id NULL) and may never update or delete a message.
// Assistant, system and tool rows are written server-side only
// (append_message, M2-4; approval functions, M3). The tests act as the
// `authenticated` role with `auth.uid()` set to user A via `setTestUser`,
// so the RLS policies — not just the grants — are what is exercised.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  callAs,
  createTestDb,
  createTestUser,
  setTestUser,
} from "./helpers";

describe("messages table (M2-2)", () => {
  let db: PGlite;
  let userA: string;
  let userB: string;
  let conversationId: string;

  beforeAll(async () => {
    db = await createTestDb();
    userA = await createTestUser(db);
    userB = await createTestUser(db);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await setTestUser(db, userA);
    const r = await callAs<{ id: string }>(
      db,
      "authenticated",
      "INSERT INTO conversations (title) VALUES ('test') RETURNING id",
    );
    conversationId = r.rows[0].id;
  });

  afterEach(async () => {
    // Superuser cleanup: deleting the conversation cascades to its messages.
    // (The test users live for the whole file; the database is discarded.)
    await db.query("DELETE FROM conversations WHERE id = $1", [conversationId]);
  });

  it("auth.uid() follows setTestUser", async () => {
    const r = await db.query<{ uid: string }>("SELECT auth.uid() AS uid");
    expect(r.rows[0].uid).toBe(userA);
  });

  it("client can insert a plain user message and read it back", async () => {
    const inserted = await callAs<{ id: string }>(
      db,
      "authenticated",
      "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', 'hello') RETURNING id",
      [conversationId],
    );
    expect(inserted.rows).toHaveLength(1);
    const read = await callAs<{ role: string; content: string }>(
      db,
      "authenticated",
      "SELECT role, content FROM messages WHERE id = $1",
      [inserted.rows[0].id],
    );
    expect(read.rows).toEqual([{ role: "user", content: "hello" }]);
  });

  it.each(["assistant", "system", "tool"])(
    "client cannot insert a %s message",
    async (role) => {
      await expect(
        callAs(
          db,
          "authenticated",
          "INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, 'forged')",
          [conversationId, role],
        ),
      ).rejects.toThrow(/row-level security/);
    },
  );

  it("client cannot insert a user message with parts set", async () => {
    await expect(
      callAs(
        db,
        "authenticated",
        "INSERT INTO messages (conversation_id, role, content, parts) VALUES ($1, 'user', 'x', '{}'::jsonb)",
        [conversationId],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("client cannot insert a user message with tool_call_id set", async () => {
    await expect(
      callAs(
        db,
        "authenticated",
        "INSERT INTO messages (conversation_id, role, content, tool_call_id) VALUES ($1, 'user', 'x', 'call_1')",
        [conversationId],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("client cannot insert a message for another user", async () => {
    await expect(
      callAs(
        db,
        "authenticated",
        "INSERT INTO messages (conversation_id, user_id, role, content) VALUES ($1, $2, 'user', 'x')",
        [conversationId, userB],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("client cannot update a message", async () => {
    const inserted = await callAs<{ id: string }>(
      db,
      "authenticated",
      "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', 'original') RETURNING id",
      [conversationId],
    );
    await expect(
      callAs(
        db,
        "authenticated",
        "UPDATE messages SET content = 'edited' WHERE id = $1",
        [inserted.rows[0].id],
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("client cannot delete a message", async () => {
    const inserted = await callAs<{ id: string }>(
      db,
      "authenticated",
      "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', 'keep me') RETURNING id",
      [conversationId],
    );
    await expect(
      callAs(db, "authenticated", "DELETE FROM messages WHERE id = $1", [
        inserted.rows[0].id,
      ]),
    ).rejects.toThrow(/permission denied/);
  });
});
