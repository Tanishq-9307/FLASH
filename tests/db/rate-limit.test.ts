// Rate-limit database tests (M1-5, DATABASE.md §6 "Concurrency and limits").
//
// Proves the limiter instead of assuming it: only service_role may execute
// the functions, 20 parallel reserves with cap 5 never exceed 5, refunds
// clamp at 0 and apply to the original reservation date.
//
// PGlite limitation, recorded honestly: PGlite is a single connection, so
// concurrent queries are serialised by the driver. The parallel test proves
// the cap logic under 20 concurrent client calls; true server-side
// parallelism (separate connections racing) is not exercisable here and
// belongs on the dev-project checklist when a live dev database exists.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  callAs,
  createTestDb,
  createTestUser,
  deleteTestUser,
  kolkataToday,
  usageCount,
} from "./helpers";

function asDate(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

describe("rate-limit functions", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  // Each test gets its own user, created and deleted through the admin-API
  // helpers, so tests never share cap state.
  async function withUser<T>(fn: (userId: string) => Promise<T>): Promise<T> {
    const userId = await createTestUser(db);
    try {
      return await fn(userId);
    } finally {
      await deleteTestUser(db, userId);
    }
  }

  it("anon gets permission denied calling reserve_api_call", async () => {
    await withUser(async (userId) => {
      await expect(
        callAs(db, "anon", "SELECT * FROM reserve_api_call($1, 5)", [userId]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("authenticated gets permission denied calling reserve_api_call", async () => {
    await withUser(async (userId) => {
      await expect(
        callAs(db, "authenticated", "SELECT * FROM reserve_api_call($1, 5)", [userId]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("anon gets permission denied calling refund_api_call", async () => {
    await withUser(async (userId) => {
      const today = await kolkataToday(db);
      await expect(
        callAs(db, "anon", "SELECT refund_api_call($1, $2)", [userId, today]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("authenticated gets permission denied calling refund_api_call", async () => {
    await withUser(async (userId) => {
      const today = await kolkataToday(db);
      await expect(
        callAs(db, "authenticated", "SELECT refund_api_call($1, $2)", [userId, today]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("service_role reserves and the row carries the Kolkata date", async () => {
    await withUser(async (userId) => {
      const today = await kolkataToday(db);
      const r = await callAs<{ model_calls: number; usage_date: Date | string }>(
        db,
        "service_role",
        "SELECT * FROM reserve_api_call($1, 20)",
        [userId],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].model_calls).toBe(1);
      expect(asDate(r.rows[0].usage_date)).toBe(today);
    });
  });

  it("service_role refunds", async () => {
    await withUser(async (userId) => {
      const today = await kolkataToday(db);
      await callAs(db, "service_role", "SELECT * FROM reserve_api_call($1, 20)", [userId]);
      expect(await usageCount(db, userId)).toBe(1);
      await callAs(db, "service_role", "SELECT refund_api_call($1, $2)", [userId, today]);
      expect(await usageCount(db, userId)).toBe(0);
    });
  });

  it("20 parallel reserves with cap 5 never exceed 5", async () => {
    await withUser(async (userId) => {
      // One role for the whole batch: SET ROLE is session state on PGlite's
      // single connection, so per-call role switches would interleave.
      await db.query("SET ROLE service_role");
      let succeeded = 0;
      try {
        const results = await Promise.all(
          Array.from({ length: 20 }, () =>
            db.query("SELECT * FROM reserve_api_call($1, 5)", [userId]),
          ),
        );
        succeeded = results.filter((r) => r.rows.length === 1).length;
      } finally {
        await db.query("RESET ROLE");
      }
      expect(succeeded).toBe(5);
      expect(await usageCount(db, userId)).toBe(5);
    });
  });

  it("refund clamps at 0", async () => {
    await withUser(async (userId) => {
      const today = await kolkataToday(db);
      await callAs(db, "service_role", "SELECT * FROM reserve_api_call($1, 20)", [userId]);
      for (let i = 0; i < 3; i++) {
        await callAs(db, "service_role", "SELECT refund_api_call($1, $2)", [userId, today]);
      }
      expect(await usageCount(db, userId)).toBe(0);
    });
  });

  it("refund applies to the original date only", async () => {
    await withUser(async (userId) => {
      const today = await kolkataToday(db);
      const yesterday = new Date(`${today}T00:00:00Z`);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const yesterdayStr = yesterday.toISOString().slice(0, 10);
      await callAs(db, "service_role", "SELECT * FROM reserve_api_call($1, 20)", [userId]);
      await callAs(db, "service_role", "SELECT refund_api_call($1, $2)", [
        userId,
        yesterdayStr,
      ]);
      expect(await usageCount(db, userId)).toBe(1);
      await callAs(db, "service_role", "SELECT refund_api_call($1, $2)", [userId, today]);
      expect(await usageCount(db, userId)).toBe(0);
    });
  });
});
