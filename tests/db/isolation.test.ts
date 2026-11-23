// Isolation and privilege tests (M2-5, DATABASE.md §6).
//
// Two test users, A and B, created via the admin-API equivalent in dev
// only and cleaned up afterwards. Proves the ownership rules: A cannot see
// or touch B's rows in any table, the catalog has RLS on every public
// table with no privileges for `anon`, the service-role functions refuse
// both client roles, `api_usage` is read-only for clients, new tables get
// no default privileges, and deleting a user removes all of their rows.
// The three authenticated functions and the approval/log tables do not
// exist yet (M3) — the "nine service-role functions" check in §6 covers
// the three that exist in M2; the rest are proven when M3 lands.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  callAs,
  createTestDb,
  createTestUser,
  setTestUser,
} from "./helpers";

const TABLES = ["conversations", "messages", "tasks", "notes", "settings", "api_usage"];

describe("isolation and privileges (M2-5)", () => {
  let db: PGlite;
  let userA: string;
  let userB: string;
  let convB: string;
  let taskA: string;

  beforeAll(async () => {
    db = await createTestDb();
    userA = await createTestUser(db);
    userB = await createTestUser(db);

    // Seed B's rows (as B).
    await setTestUser(db, userB);
    const conv = await callAs<{ id: string }>(
      db,
      "authenticated",
      "INSERT INTO conversations (title) VALUES ('B conv') RETURNING id",
    );
    convB = conv.rows[0].id;
    await callAs(
      db,
      "authenticated",
      "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', 'B says hi')",
      [convB],
    );
    await callAs(
      db,
      "authenticated",
      "INSERT INTO tasks (title) VALUES ('B task')",
    );
    await callAs(
      db,
      "authenticated",
      "INSERT INTO notes (title, content) VALUES ('B note', 'B body')",
    );

    // Seed one row for A (used by the read-back and update tests).
    await setTestUser(db, userA);
    const task = await callAs<{ id: string }>(
      db,
      "authenticated",
      "INSERT INTO tasks (title) VALUES ('A task') RETURNING id",
    );
    taskA = task.rows[0].id;
  });

  afterAll(async () => {
    await db.close();
  });

  it("A sees none of B's rows in any table", async () => {
    await setTestUser(db, userA);
    for (const table of TABLES) {
      // settings and api_usage have no id column; probe with SELECT 1.
      const rows = await callAs(
        db,
        "authenticated",
        `SELECT 1 FROM ${table} WHERE user_id = $1`,
        [userB],
      );
      expect(rows.rows).toHaveLength(0);
    }
    // And an unfiltered read returns only A's rows.
    const tasks = await callAs<{ title: string }>(
      db,
      "authenticated",
      "SELECT title FROM tasks",
    );
    expect(tasks.rows).toEqual([{ title: "A task" }]);
  });

  it("A cannot insert a task with user_id = B", async () => {
    await setTestUser(db, userA);
    await expect(
      callAs(
        db,
        "authenticated",
        "INSERT INTO tasks (user_id, title) VALUES ($1, 'forged')",
        [userB],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("A cannot change a task's user_id", async () => {
    await setTestUser(db, userA);
    await expect(
      callAs(db, "authenticated", "UPDATE tasks SET user_id = $1 WHERE id = $2", [
        userB,
        taskA,
      ]),
    ).rejects.toThrow(/row-level security/);
  });

  it("A cannot insert a message into B's conversation", async () => {
    await setTestUser(db, userA);
    await expect(
      callAs(
        db,
        "authenticated",
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', 'sneaky')",
        [convB],
      ),
    ).rejects.toThrow(/violates foreign key constraint/);
  });

  it("catalog: RLS on every table in public; anon holds no privileges", async () => {
    const noRls = await db.query<{ relname: string }>(
      "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity",
    );
    expect(noRls.rows).toHaveLength(0);
    const anon = await db.query(
      "SELECT 1 FROM information_schema.table_privileges WHERE grantee = 'anon'",
    );
    expect(anon.rows).toHaveLength(0);
  });

  it.each(["reserve_api_call", "refund_api_call", "append_message"])(
    "anon and authenticated cannot call %s (service-role only)",
    async (fn) => {
      const args =
        fn === "refund_api_call"
          ? "($1, CURRENT_DATE)"
          : fn === "append_message"
            ? "($1, $1, 'assistant', 'x', NULL, NULL)"
            : "($1, 20)";
      for (const role of ["anon", "authenticated"] as const) {
        await expect(
          callAs(db, role, `SELECT ${fn}${args}`, [userA]),
        ).rejects.toThrow(/permission denied/);
      }
    },
  );

  it("authenticated cannot INSERT or UPDATE api_usage", async () => {
    await setTestUser(db, userA);
    await expect(
      callAs(
        db,
        "authenticated",
        "INSERT INTO api_usage (user_id, usage_date, model_calls) VALUES ($1, CURRENT_DATE, 1)",
        [userA],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      callAs(
        db,
        "authenticated",
        "UPDATE api_usage SET model_calls = 99 WHERE user_id = $1",
        [userA],
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("a new table gets no default privileges for anon or authenticated", async () => {
    await db.query("CREATE TABLE throwaway_check (id int)");
    try {
      const grants = await db.query(
        "SELECT 1 FROM information_schema.table_privileges WHERE table_name = 'throwaway_check' AND grantee IN ('anon', 'authenticated')",
      );
      expect(grants.rows).toHaveLength(0);
    } finally {
      await db.query("DROP TABLE throwaway_check");
    }
  });

  it("deleting a user removes all of their rows", async () => {
    const userC = await createTestUser(db);
    await setTestUser(db, userC);
    await callAs(
      db,
      "authenticated",
      "INSERT INTO settings (memory_enabled) VALUES (false)",
    );
    await callAs(
      db,
      "service_role",
      "SELECT reserve_api_call($1, 20)",
      [userC],
    );
    const conv = await callAs<{ id: string }>(
      db,
      "authenticated",
      "INSERT INTO conversations (title) VALUES ('C conv') RETURNING id",
    );
    await callAs(
      db,
      "authenticated",
      "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', 'C msg')",
      [conv.rows[0].id],
    );
    await callAs(
      db,
      "authenticated",
      "INSERT INTO tasks (title) VALUES ('C task')",
    );
    await callAs(
      db,
      "authenticated",
      "INSERT INTO notes (title, content) VALUES ('C note', 'C body')",
    );
    for (const table of TABLES) {
      const before = await db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM ${table} WHERE user_id = $1`,
        [userC],
      );
      expect(before.rows[0].n).toBeGreaterThan(0);
    }
    await db.query("DELETE FROM auth.users WHERE id = $1", [userC]);
    for (const table of TABLES) {
      const after = await db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM ${table} WHERE user_id = $1`,
        [userC],
      );
      expect(after.rows[0].n).toBe(0);
    }
  });

  it("updated_at changes on update for conversations and notes", async () => {
    await setTestUser(db, userA);
    const conv = await callAs<{ id: string; updated_at: string }>(
      db,
      "authenticated",
      "INSERT INTO conversations (title) VALUES ('t') RETURNING id, updated_at",
    );
    await db.query("SELECT pg_sleep(0.05)");
    const convUpdated = await callAs<{ updated_at: string }>(
      db,
      "authenticated",
      "UPDATE conversations SET title = 't2' WHERE id = $1 RETURNING updated_at",
      [conv.rows[0].id],
    );
    expect(new Date(convUpdated.rows[0].updated_at).getTime()).toBeGreaterThan(
      new Date(conv.rows[0].updated_at).getTime(),
    );
    const note = await callAs<{ id: string; updated_at: string }>(
      db,
      "authenticated",
      "INSERT INTO notes (title, content) VALUES ('n', 'b') RETURNING id, updated_at",
    );
    await db.query("SELECT pg_sleep(0.05)");
    const noteUpdated = await callAs<{ updated_at: string }>(
      db,
      "authenticated",
      "UPDATE notes SET content = 'b2' WHERE id = $1 RETURNING updated_at",
      [note.rows[0].id],
    );
    expect(new Date(noteUpdated.rows[0].updated_at).getTime()).toBeGreaterThan(
      new Date(note.rows[0].updated_at).getTime(),
    );
  });
});
