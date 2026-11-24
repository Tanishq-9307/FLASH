// Search-quota database tests (M6-1, DATABASE.md §6 "Concurrency and limits").
//
// Mirrors the model-call rate-limit tests (M1-5): only service_role may
// execute the functions, 20 parallel reserves with cap 5 never exceed 5,
// refunds clamp at 0 and apply to the original reservation date. Plus the
// M3-27 lesson built in from the start: a cap of 0 fails closed on a
// fresh day (the INSERT itself is conditional on p_cap >= 1).
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
} from "./helpers";

function asDate(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

/** Current searches count for a user (read as superuser, for assertions). */
async function searchCount(db: PGlite, userId: string): Promise<number> {
  const r = await db.query<{ searches: number }>(
    "SELECT searches FROM search_usage WHERE user_id = $1",
    [userId],
  );
  return r.rows.length === 0 ? 0 : r.rows[0].searches;
}

type ReserveRow = { searches: number; usage_date: Date | string };

async function reserve(
  db: PGlite,
  userId: string,
  cap: number,
): Promise<ReserveRow[]> {
  const result = await callAs<ReserveRow>(
    db,
    "service_role",
    "SELECT * FROM reserve_search($1, $2)",
    [userId, cap],
  );
  return result.rows;
}

describe("search-quota functions", () => {
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

  it("anon gets permission denied calling reserve_search", async () => {
    await withUser(async (userId) => {
      await expect(
        callAs(db, "anon", "SELECT * FROM reserve_search($1, 5)", [userId]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("authenticated gets permission denied calling reserve_search", async () => {
    await withUser(async (userId) => {
      await expect(
        callAs(db, "authenticated", "SELECT * FROM reserve_search($1, 5)", [userId]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("anon gets permission denied calling refund_search", async () => {
    await withUser(async (userId) => {
      const today = await kolkataToday(db);
      await expect(
        callAs(db, "anon", "SELECT refund_search($1, $2)", [userId, today]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("authenticated gets permission denied calling refund_search", async () => {
    await withUser(async (userId) => {
      const today = await kolkataToday(db);
      await expect(
        callAs(db, "authenticated", "SELECT refund_search($1, $2)", [userId, today]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("service_role reserves and the row carries the Kolkata date", async () => {
    await withUser(async (userId) => {
      const today = await kolkataToday(db);
      const rows = await reserve(db, userId, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0].searches).toBe(1);
      expect(asDate(rows[0].usage_date)).toBe(today);
    });
  });

  it("service_role refunds", async () => {
    await withUser(async (userId) => {
      const today = await kolkataToday(db);
      await reserve(db, userId, 10);
      expect(await searchCount(db, userId)).toBe(1);
      await callAs(db, "service_role", "SELECT refund_search($1, $2)", [userId, today]);
      expect(await searchCount(db, userId)).toBe(0);
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
            db.query("SELECT * FROM reserve_search($1, 5)", [userId]),
          ),
        );
        succeeded = results.filter((r) => r.rows.length === 1).length;
      } finally {
        await db.query("RESET ROLE");
      }
      expect(succeeded).toBe(5);
      expect(await searchCount(db, userId)).toBe(5);
    });
  });

  it("refund clamps at 0", async () => {
    await withUser(async (userId) => {
      const today = await kolkataToday(db);
      await reserve(db, userId, 10);
      for (let i = 0; i < 3; i++) {
        await callAs(db, "service_role", "SELECT refund_search($1, $2)", [userId, today]);
      }
      expect(await searchCount(db, userId)).toBe(0);
    });
  });

  it("refund applies to the original date only", async () => {
    await withUser(async (userId) => {
      const today = await kolkataToday(db);
      const yesterday = new Date(`${today}T00:00:00Z`);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const yesterdayStr = yesterday.toISOString().slice(0, 10);
      await reserve(db, userId, 10);
      await callAs(db, "service_role", "SELECT refund_search($1, $2)", [
        userId,
        yesterdayStr,
      ]);
      expect(await searchCount(db, userId)).toBe(1);
      await callAs(db, "service_role", "SELECT refund_search($1, $2)", [userId, today]);
      expect(await searchCount(db, userId)).toBe(0);
    });
  });

  it("cap 0 on a fresh day returns no rows and writes nothing", async () => {
    await withUser(async (userId) => {
      expect(await reserve(db, userId, 0)).toHaveLength(0);
      expect(await searchCount(db, userId)).toBe(0);
    });
  });

  it("cap 0 with an existing usage row returns no rows and changes nothing", async () => {
    await withUser(async (userId) => {
      // Seed one search under a normal cap, then lower the cap to 0:
      // the UPDATE path must also refuse (searches 1 is not < 0).
      const seeded = await reserve(db, userId, 5);
      expect(seeded).toHaveLength(1);
      expect(await reserve(db, userId, 0)).toHaveLength(0);
      expect(await searchCount(db, userId)).toBe(1);
    });
  });
});
