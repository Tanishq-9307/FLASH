// M3-27 rate-cap verification: reserve_api_call fails closed to a cap
// of 0 (M1 hole found while writing the M3-20 cap test).
//
// The original INSERT ... ON CONFLICT only checked the cap on the
// UPDATE path, so a fresh day's first call inserted unconditionally and
// a cap of 0 still allowed exactly one call. The fix makes the INSERT
// itself conditional on p_cap >= 1, so a zero (or negative, or NULL)
// cap returns no rows and writes nothing — which the chat route reads
// as "cap reached" (429).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  callAs,
  createTestDb,
  createTestUser,
  deleteTestUser,
  usageCount,
} from "./helpers";

type ReserveRow = { model_calls: number; usage_date: Date | string };

async function reserve(
  db: PGlite,
  userId: string,
  cap: number,
): Promise<ReserveRow[]> {
  const result = await callAs<ReserveRow>(
    db,
    "service_role",
    "SELECT * FROM reserve_api_call($1, $2)",
    [userId, cap],
  );
  return result.rows;
}

describe("reserve_api_call cap-zero fail-closed (M3-27)", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function withUser<T>(fn: (userId: string) => Promise<T>): Promise<T> {
    const userId = await createTestUser(db);
    try {
      return await fn(userId);
    } finally {
      await deleteTestUser(db, userId);
    }
  }

  it("cap 0 on a fresh day returns no rows and writes nothing", async () => {
    await withUser(async (userId) => {
      expect(await reserve(db, userId, 0)).toHaveLength(0);
      expect(await usageCount(db, userId)).toBe(0);
    });
  });

  it("cap 0 with an existing usage row returns no rows and changes nothing", async () => {
    await withUser(async (userId) => {
      // Seed one call under a normal cap, then lower the cap to 0:
      // the UPDATE path must also refuse (model_calls 1 is not < 0).
      const seeded = await reserve(db, userId, 5);
      expect(seeded).toHaveLength(1);
      expect(await reserve(db, userId, 0)).toHaveLength(0);
      expect(await usageCount(db, userId)).toBe(1);
    });
  });

  it("negative cap returns no rows and writes nothing", async () => {
    await withUser(async (userId) => {
      expect(await reserve(db, userId, -3)).toHaveLength(0);
      expect(await usageCount(db, userId)).toBe(0);
    });
  });

  it("cap 1 on a fresh day still reserves exactly one call", async () => {
    await withUser(async (userId) => {
      const first = await reserve(db, userId, 1);
      expect(first).toHaveLength(1);
      expect(first[0].model_calls).toBe(1);
      expect(await reserve(db, userId, 1)).toHaveLength(0);
      expect(await usageCount(db, userId)).toBe(1);
    });
  });
});
