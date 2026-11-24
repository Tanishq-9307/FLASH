// Usage-meter record functions (owner requirement 2026-11-24).
//
// record_api_call and record_search count usage unconditionally —
// there is no cap to hit, so there is no refusal path to test: 20
// parallel records all succeed and the count is exactly 20, and a
// count far past the old caps keeps incrementing. Only service_role
// may execute them; refunds (unchanged) still clamp at 0.
//
// PGlite limitation, recorded honestly: PGlite is a single
// connection, so concurrent queries are serialised by the driver.
// The parallel test proves the counting logic under 20 concurrent
// client calls; true server-side parallelism (separate connections
// racing) is not exercisable here.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  callAs,
  createTestDb,
  createTestUser,
  deleteTestUser,
  kolkataToday,
} from "./helpers";

function asDate(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

async function modelCount(db: PGlite, userId: string): Promise<number> {
  const r = await db.query<{ model_calls: number }>(
    "SELECT model_calls FROM api_usage WHERE user_id = $1",
    [userId],
  );
  return r.rows.length === 0 ? 0 : r.rows[0].model_calls;
}

async function searchCount(db: PGlite, userId: string): Promise<number> {
  const r = await db.query<{ searches: number }>(
    "SELECT searches FROM search_usage WHERE user_id = $1",
    [userId],
  );
  return r.rows.length === 0 ? 0 : r.rows[0].searches;
}

describe("usage-meter record functions", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  // Each test gets its own user, created and deleted through the admin-API
  // helpers, so tests never share usage state.
  async function withUser<T>(fn: (userId: string) => Promise<T>): Promise<T> {
    const userId = await createTestUser(db);
    try {
      return await fn(userId);
    } finally {
      await deleteTestUser(db, userId);
    }
  }

  it("anon gets permission denied calling record_api_call", async () => {
    await withUser(async (userId) => {
      await expect(
        callAs(db, "anon", "SELECT * FROM record_api_call($1)", [userId]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("authenticated gets permission denied calling record_api_call", async () => {
    await withUser(async (userId) => {
      await expect(
        callAs(db, "authenticated", "SELECT * FROM record_api_call($1)", [userId]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("anon gets permission denied calling record_search", async () => {
    await withUser(async (userId) => {
      await expect(
        callAs(db, "anon", "SELECT * FROM record_search($1)", [userId]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("authenticated gets permission denied calling record_search", async () => {
    await withUser(async (userId) => {
      await expect(
        callAs(db, "authenticated", "SELECT * FROM record_search($1)", [userId]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("service_role records a model call and the row carries the Kolkata date", async () => {
    await withUser(async (userId) => {
      const today = await kolkataToday(db);
      const result = await callAs<{ model_calls: number; usage_date: Date | string }>(
        db,
        "service_role",
        "SELECT * FROM record_api_call($1)",
        [userId],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].model_calls).toBe(1);
      expect(asDate(result.rows[0].usage_date)).toBe(today);
      expect(await modelCount(db, userId)).toBe(1);
    });
  });

  it("service_role records a search and the row carries the Kolkata date", async () => {
    await withUser(async (userId) => {
      const today = await kolkataToday(db);
      const result = await callAs<{ searches: number; usage_date: Date | string }>(
        db,
        "service_role",
        "SELECT * FROM record_search($1)",
        [userId],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].searches).toBe(1);
      expect(asDate(result.rows[0].usage_date)).toBe(today);
      expect(await searchCount(db, userId)).toBe(1);
    });
  });

  it("20 parallel records count exactly 20 — no cap, no refusal", async () => {
    await withUser(async (userId) => {
      const calls = Array.from({ length: 20 }, () =>
        callAs(db, "service_role", "SELECT * FROM record_api_call($1)", [userId]),
      );
      const results = await Promise.all(calls);
      expect(results.every((r) => r.rows.length === 1)).toBe(true);
      expect(await modelCount(db, userId)).toBe(20);
    });
  });

  it("20 parallel search records count exactly 20 — no cap, no refusal", async () => {
    await withUser(async (userId) => {
      const calls = Array.from({ length: 20 }, () =>
        callAs(db, "service_role", "SELECT * FROM record_search($1)", [userId]),
      );
      const results = await Promise.all(calls);
      expect(results.every((r) => r.rows.length === 1)).toBe(true);
      expect(await searchCount(db, userId)).toBe(20);
    });
  });

  it("recording past the old caps keeps incrementing", async () => {
    await withUser(async (userId) => {
      // The old caps were 20 model calls and 10 searches a day.
      // Recording 25 model calls and 15 searches must all succeed.
      for (let i = 0; i < 25; i++) {
        await callAs(db, "service_role", "SELECT * FROM record_api_call($1)", [userId]);
      }
      for (let i = 0; i < 15; i++) {
        await callAs(db, "service_role", "SELECT * FROM record_search($1)", [userId]);
      }
      expect(await modelCount(db, userId)).toBe(25);
      expect(await searchCount(db, userId)).toBe(15);
    });
  });

  it("refund_api_call still clamps at 0", async () => {
    await withUser(async (userId) => {
      const today = await kolkataToday(db);
      await callAs(db, "service_role", "SELECT refund_api_call($1, $2)", [userId, today]);
      expect(await modelCount(db, userId)).toBe(0);
    });
  });

  it("refund_search still clamps at 0", async () => {
    await withUser(async (userId) => {
      const today = await kolkataToday(db);
      await callAs(db, "service_role", "SELECT refund_search($1, $2)", [userId, today]);
      expect(await searchCount(db, userId)).toBe(0);
    });
  });
});
