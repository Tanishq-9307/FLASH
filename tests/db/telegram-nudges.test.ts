// Telegram proactive migration tests (Phase 3, migration
// 20261125020000_telegram_proactive.sql): the settings switch and the
// telegram_nudges dedupe table, proven against real PGlite Postgres —
// catalog (RLS, policies, grants), the composite primary key that
// makes dedupe work, and owner isolation.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { callAs, createTestDb, createTestUser, setTestUser } from "./helpers";

describe("telegram proactive tables (20261125020000)", () => {
  let db: PGlite;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    db = await createTestDb();
    userA = await createTestUser(db);
    userB = await createTestUser(db);
    await setTestUser(db, userA);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM telegram_nudges");
    await db.query("DELETE FROM settings");
  });

  it("catalog: settings has telegram_proactive_enabled default true; telegram_nudges has RLS, owner SELECT only", async () => {
    const col = await db.query<{ column_default: string }>(
      "SELECT column_default FROM information_schema.columns WHERE table_name = 'settings' AND column_name = 'telegram_proactive_enabled'",
    );
    expect(col.rows).toHaveLength(1);
    expect(col.rows[0].column_default).toBe("true");

    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'telegram_nudges'",
    );
    expect(rls.rows).toEqual([
      { relname: "telegram_nudges", relrowsecurity: true },
    ]);
    const policies = await db.query<{ policyname: string; cmd: string }>(
      "SELECT policyname, cmd FROM pg_policies WHERE tablename = 'telegram_nudges' ORDER BY policyname",
    );
    expect(policies.rows).toEqual([
      { policyname: "telegram_nudges_owner_select", cmd: "SELECT" },
    ]);
    const grants = await db.query<{ privilege_type: string }>(
      "SELECT privilege_type FROM information_schema.table_privileges WHERE table_name = 'telegram_nudges' AND grantee = 'authenticated' ORDER BY privilege_type",
    );
    expect(grants.rows.map((r) => r.privilege_type)).toEqual(["SELECT"]);
    const anon = await db.query(
      "SELECT 1 FROM information_schema.table_privileges WHERE table_name = 'telegram_nudges' AND grantee = 'anon'",
    );
    expect(anon.rows).toHaveLength(0);
  });

  it("dedupe: the same (user_id, nudge_key) cannot be inserted twice", async () => {
    await db.query(
      "INSERT INTO telegram_nudges (user_id, nudge_key, kind, message) VALUES ($1, 'overdue:t1:2026-11-20', 'overdue_task', 'Overdue: x')",
      [userA],
    );
    await expect(
      db.query(
        "INSERT INTO telegram_nudges (user_id, nudge_key, kind, message) VALUES ($1, 'overdue:t1:2026-11-20', 'overdue_task', 'Overdue: x')",
        [userA],
      ),
    ).rejects.toThrow(/duplicate key/);
    // A different key for the same user, and the same key for another
    // user, both insert fine.
    await db.query(
      "INSERT INTO telegram_nudges (user_id, nudge_key, kind, message) VALUES ($1, 'overdue:t2:2026-11-20', 'overdue_task', 'Overdue: y')",
      [userA],
    );
    await db.query(
      "INSERT INTO telegram_nudges (user_id, nudge_key, kind, message) VALUES ($1, 'overdue:t1:2026-11-20', 'overdue_task', 'Overdue: x')",
      [userB],
    );
    const count = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM telegram_nudges",
    );
    expect(count.rows[0].n).toBe("3");
  });

  it("isolation: a user cannot see another user's nudge rows", async () => {
    await db.query(
      "INSERT INTO telegram_nudges (user_id, nudge_key, kind, message) VALUES ($1, 'k1', 'overdue_task', 'm')",
      [userA],
    );
    await db.query(
      "INSERT INTO telegram_nudges (user_id, nudge_key, kind, message) VALUES ($1, 'k2', 'overdue_task', 'm')",
      [userB],
    );
    const asA = await callAs<{ nudge_key: string }>(
      db,
      "authenticated",
      "SELECT nudge_key FROM telegram_nudges ORDER BY nudge_key",
      [],
    );
    expect(asA.rows).toEqual([{ nudge_key: "k1" }]);
    // anon holds no grant at all, so the query is denied rather than
    // returning empty rows — the table is invisible to anonymous calls.
    await expect(
      callAs<{ nudge_key: string }>(
        db,
        "anon",
        "SELECT nudge_key FROM telegram_nudges",
        [],
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("settings: the proactive switch defaults on and can be turned off", async () => {
    await db.query(
      "INSERT INTO settings (user_id) VALUES ($1)",
      [userA],
    );
    const before = await db.query<{ telegram_proactive_enabled: boolean }>(
      "SELECT telegram_proactive_enabled FROM settings WHERE user_id = $1",
      [userA],
    );
    expect(before.rows[0].telegram_proactive_enabled).toBe(true);
    await db.query(
      "UPDATE settings SET telegram_proactive_enabled = false WHERE user_id = $1",
      [userA],
    );
    const after = await db.query<{ telegram_proactive_enabled: boolean }>(
      "SELECT telegram_proactive_enabled FROM settings WHERE user_id = $1",
      [userA],
    );
    expect(after.rows[0].telegram_proactive_enabled).toBe(false);
  });
});
