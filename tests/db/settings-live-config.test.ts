// Settings live-configuration tests (Phase 2, 2026-11-25).
//
// Covers the migration: the three new columns on the existing
// `settings` row with their defaults, the unchanged owner-only
// policies and grants (no new table, no DELETE), the read/write
// round-trip for all five settings as the owner, and isolation
// between two users. "Missing row means defaults" is a TypeScript
// rule (settingsWithDefaults, tests/settings.test.ts), not a
// database rule, so it is proven there.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { callAs, createTestDb, createTestUser, setTestUser } from "./helpers";

describe("settings live configuration (Phase 2)", () => {
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
    await db.query("DELETE FROM settings");
    await setTestUser(db, userA);
  });

  it("catalog: the three new columns exist with the right defaults", async () => {
    const cols = await db.query<{
      column_name: string;
      column_default: string;
      is_nullable: string;
    }>(
      `SELECT column_name, column_default, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'settings'
         AND column_name IN ('default_coding_mode', 'reduce_motion', 'show_usage_meter')
       ORDER BY column_name`,
    );
    expect(cols.rows).toEqual([
      { column_name: "default_coding_mode", column_default: "false", is_nullable: "NO" },
      { column_name: "reduce_motion", column_default: "false", is_nullable: "NO" },
      { column_name: "show_usage_meter", column_default: "true", is_nullable: "NO" },
    ]);
  });

  it("catalog: owner-only SELECT/INSERT/UPDATE, no DELETE, anon holds nothing", async () => {
    const policies = await db.query<{ cmd: string }>(
      "SELECT cmd FROM pg_policies WHERE tablename = 'settings' ORDER BY cmd",
    );
    expect(policies.rows.map((r) => r.cmd)).toEqual(["INSERT", "SELECT", "UPDATE"]);
    const anon = await db.query(
      "SELECT 1 FROM information_schema.table_privileges WHERE table_name = 'settings' AND grantee = 'anon'",
    );
    expect(anon.rows).toHaveLength(0);
    const grants = await db.query<{ privilege_type: string }>(
      "SELECT privilege_type FROM information_schema.table_privileges WHERE table_name = 'settings' AND grantee = 'authenticated' ORDER BY privilege_type",
    );
    expect(grants.rows.map((r) => r.privilege_type)).toEqual([
      "INSERT",
      "SELECT",
      "UPDATE",
    ]);
  });

  it("insert takes the defaults; upsert round-trips all five settings", async () => {
    const inserted = await callAs<{
      memory_enabled: boolean;
      telegram_proactive_enabled: boolean;
      default_coding_mode: boolean;
      reduce_motion: boolean;
      show_usage_meter: boolean;
    }>(
      db,
      "authenticated",
      "INSERT INTO settings DEFAULT VALUES RETURNING memory_enabled, telegram_proactive_enabled, default_coding_mode, reduce_motion, show_usage_meter",
    );
    expect(inserted.rows).toEqual([
      {
        memory_enabled: true,
        telegram_proactive_enabled: true,
        default_coding_mode: false,
        reduce_motion: false,
        show_usage_meter: true,
      },
    ]);

    // The panel's write path: upsert only the changed fields, the
    // others survive untouched. (The user id travels as a parameter:
    // an explicit auth.uid() in query text is denied in PGlite, which
    // grants the built-in roles no USAGE on schema auth — the column
    // DEFAULT and the RLS policies resolve it internally instead.)
    const updated = await callAs<{ default_coding_mode: boolean; reduce_motion: boolean }>(
      db,
      "authenticated",
      `INSERT INTO settings (user_id, default_coding_mode, reduce_motion, show_usage_meter)
       VALUES ($1, true, true, false)
       ON CONFLICT (user_id) DO UPDATE
         SET default_coding_mode = EXCLUDED.default_coding_mode,
             reduce_motion = EXCLUDED.reduce_motion,
             show_usage_meter = EXCLUDED.show_usage_meter
       RETURNING default_coding_mode, reduce_motion`,
      [userA],
    );
    expect(updated.rows).toEqual([{ default_coding_mode: true, reduce_motion: true }]);

    const read = await callAs<{
      memory_enabled: boolean;
      show_usage_meter: boolean;
    }>(
      db,
      "authenticated",
      "SELECT memory_enabled, show_usage_meter FROM settings WHERE user_id = $1",
      [userA],
    );
    // Untouched columns kept their values; the flipped ones changed.
    expect(read.rows).toEqual([{ memory_enabled: true, show_usage_meter: false }]);
  });

  it("isolation: B cannot read or change A's settings, and cannot forge A's user_id", async () => {
    await callAs(
      db,
      "authenticated",
      "INSERT INTO settings (default_coding_mode) VALUES (true)",
    );
    await setTestUser(db, userB);
    const read = await callAs<{ user_id: string }>(
      db,
      "authenticated",
      "SELECT user_id FROM settings",
    );
    expect(read.rows).toHaveLength(0);
    await expect(
      callAs(
        db,
        "authenticated",
        "INSERT INTO settings (user_id, default_coding_mode) VALUES ($1, true)",
        [userA],
      ),
    ).rejects.toThrow();
    // B's own row is separate: B writes, A still sees only A's row.
    await callAs(
      db,
      "authenticated",
      "INSERT INTO settings (show_usage_meter) VALUES (false)",
    );
    await setTestUser(db, userA);
    const own = await callAs<{ default_coding_mode: boolean }>(
      db,
      "authenticated",
      "SELECT default_coding_mode FROM settings WHERE user_id = $1",
      [userA],
    );
    expect(own.rows).toEqual([{ default_coding_mode: true }]);
  });

  it("no credential column exists on settings", async () => {
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'settings'
         AND (column_name ILIKE '%key%' OR column_name ILIKE '%token%'
           OR column_name ILIKE '%secret%' OR column_name ILIKE '%password%')`,
    );
    expect(cols.rows).toHaveLength(0);
  });
});
