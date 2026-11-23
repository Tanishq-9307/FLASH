// Tasks and notes tests (M2-3, DATABASE.md §3.5, §3.6, §6).
//
// Covers the catalog (RLS, policies, grants), the CHECKs, the
// `updated_at` trigger, and the full-text search: the generated `search`
// column is filled by Postgres, matching notes are returned, and EXPLAIN
// proves the GIN index is used.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { callAs, createTestDb, createTestUser, setTestUser } from "./helpers";

describe("tasks and notes tables (M2-3)", () => {
  let db: PGlite;
  let userA: string;

  beforeAll(async () => {
    db = await createTestDb();
    userA = await createTestUser(db);
    await setTestUser(db, userA);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM tasks");
    await db.query("DELETE FROM notes");
  });

  it("catalog: RLS on, 4 owner policies each, authenticated-only grants", async () => {
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('tasks', 'notes') ORDER BY relname",
    );
    expect(rls.rows).toEqual([
      { relname: "notes", relrowsecurity: true },
      { relname: "tasks", relrowsecurity: true },
    ]);
    for (const table of ["tasks", "notes"]) {
      const policies = await db.query<{ policyname: string; cmd: string }>(
        "SELECT policyname, cmd FROM pg_policies WHERE tablename = $1 ORDER BY policyname",
        [table],
      );
      expect(policies.rows.map((r) => r.cmd).sort()).toEqual([
        "DELETE",
        "INSERT",
        "SELECT",
        "UPDATE",
      ]);
      const grants = await db.query<{ privilege_type: string }>(
        "SELECT privilege_type FROM information_schema.table_privileges WHERE table_name = $1 AND grantee = 'authenticated' ORDER BY privilege_type",
        [table],
      );
      expect(grants.rows.map((r) => r.privilege_type)).toEqual([
        "DELETE",
        "INSERT",
        "SELECT",
        "UPDATE",
      ]);
      const anon = await db.query(
        "SELECT 1 FROM information_schema.table_privileges WHERE table_name = $1 AND grantee = 'anon'",
        [table],
      );
      expect(anon.rows).toHaveLength(0);
    }
  });

  it("client can insert and read a task and a note", async () => {
    const task = await callAs<{ id: string; status: string }>(
      db,
      "authenticated",
      "INSERT INTO tasks (title, due_date) VALUES ('Build arm', '2026-12-01T00:00:00Z') RETURNING id, status",
    );
    expect(task.rows[0].status).toBe("pending");
    const note = await callAs<{ id: string }>(
      db,
      "authenticated",
      "INSERT INTO notes (title, content) VALUES ('Arm notes', 'Inverse kinematics') RETURNING id",
    );
    expect(note.rows).toHaveLength(1);
    const read = await callAs<{ title: string }>(
      db,
      "authenticated",
      "SELECT title FROM tasks WHERE id = $1",
      [task.rows[0].id],
    );
    expect(read.rows).toEqual([{ title: "Build arm" }]);
  });

  it("status CHECK refuses values outside pending/completed", async () => {
    await expect(
      callAs(
        db,
        "authenticated",
        "INSERT INTO tasks (title, status) VALUES ('x', 'done')",
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("title length CHECK refuses 256 characters", async () => {
    await expect(
      callAs(
        db,
        "authenticated",
        "INSERT INTO tasks (title) VALUES ($1)",
        ["x".repeat(256)],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("updated_at changes on update", async () => {
    const inserted = await callAs<{ id: string; updated_at: string }>(
      db,
      "authenticated",
      "INSERT INTO tasks (title) VALUES ('t') RETURNING id, updated_at",
    );
    await db.query("SELECT pg_sleep(0.05)");
    const updated = await callAs<{ updated_at: string }>(
      db,
      "authenticated",
      "UPDATE tasks SET status = 'completed' WHERE id = $1 RETURNING updated_at",
      [inserted.rows[0].id],
    );
    expect(new Date(updated.rows[0].updated_at).getTime()).toBeGreaterThan(
      new Date(inserted.rows[0].updated_at).getTime(),
    );
  });

  it("search column is generated and full-text search returns matches only", async () => {
    await callAs(
      db,
      "authenticated",
      "INSERT INTO notes (title, content) VALUES ('Arm notes', 'Inverse kinematics for the four axis arm'), ('Groceries', 'Buy milk and bread')",
    );
    const generated = await db.query<{ search: string }>(
      "SELECT search FROM notes WHERE title = 'Arm notes'",
    );
    expect(generated.rows[0].search).toContain("kinemat");
    const hits = await callAs<{ title: string }>(
      db,
      "authenticated",
      "SELECT title FROM notes WHERE search @@ websearch_to_tsquery('english', 'kinematics')",
    );
    expect(hits.rows).toEqual([{ title: "Arm notes" }]);
    const misses = await callAs(
      db,
      "authenticated",
      "SELECT title FROM notes WHERE search @@ websearch_to_tsquery('english', 'sourdough')",
    );
    expect(misses.rows).toHaveLength(0);
  });

  it("EXPLAIN proves the GIN index is used for search", async () => {
    // Enough rows that the planner prefers the index over a sequential
    // scan for a selective term; ANALYZE so the planner sees the stats.
    await db.query(
      "INSERT INTO notes (title, content) SELECT 'Note ' || g, 'filler text about workshop tools ' || g FROM generate_series(1, 200) g",
    );
    await callAs(
      db,
      "authenticated",
      "INSERT INTO notes (title, content) VALUES ('Arm notes', 'Inverse kinematics for the four axis arm')",
    );
    await db.query("ANALYZE notes");
    // PGlite returns the plan column as "QUERY PLAN" (with a space).
    const plan = await db.query<Record<string, string>>(
      "EXPLAIN SELECT id FROM notes WHERE search @@ websearch_to_tsquery('english', 'kinematics')",
    );
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(text).toMatch(/notes_search_idx/);
    expect(text).toMatch(/Bitmap Index Scan/);
  });
});
