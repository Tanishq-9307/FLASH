// Reminders database tests (Phase 3): the table, RLS isolation,
// and the atomic claim — due rows claimed once, future rows left
// alone, a second claim finding nothing, and a stale `sending` row
// reclaimed after 10 minutes.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { callAs, createTestDb, createTestUser, setTestUser } from "./helpers";

describe("reminders table and claim_due_reminders (Phase 3)", () => {
  let db: PGlite;
  let userA: string;
  let userB: string;

  const insertReminder = async (
    userId: string,
    message: string,
    remindAt: string,
    status = "pending",
  ): Promise<string> => {
    const r = await db.query<{ id: string }>(
      `INSERT INTO reminders (user_id, message, remind_at, status, source)
       VALUES ($1, $2, $3, $4, 'web') RETURNING id`,
      [userId, message, remindAt, status],
    );
    return r.rows[0].id;
  };

  const claim = async (now: string) => {
    const r = await callAs<{ id: string; message: string; status: string }>(
      db,
      "service_role",
      "SELECT id, message, status FROM claim_due_reminders($1)",
      [now],
    );
    return r.rows;
  };

  beforeAll(async () => {
    db = await createTestDb();
    userA = await createTestUser(db);
    userB = await createTestUser(db);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM reminders");
    await setTestUser(db, userA);
  });

  it("stores a reminder with defaults and the due index", async () => {
    const id = await insertReminder(
      userA,
      "Submit the form",
      "2026-11-26T03:30:00Z",
    );
    const row = await db.query<{
      message: string;
      status: string;
      source: string;
      sent_at: string | null;
    }>("SELECT message, status, source, sent_at FROM reminders WHERE id = $1", [
      id,
    ]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].message).toBe("Submit the form");
    expect(row.rows[0].status).toBe("pending");
    expect(row.rows[0].source).toBe("web");
    expect(row.rows[0].sent_at).toBeNull();
  });

  it("refuses an empty or over-long message and a bad status", async () => {
    await expect(
      db.query(
        "INSERT INTO reminders (user_id, message, remind_at) VALUES ($1, '', now())",
        [userA],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        "INSERT INTO reminders (user_id, message, remind_at) VALUES ($1, $2, now())",
        [userA, "x".repeat(501)],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        "INSERT INTO reminders (user_id, message, remind_at, status) VALUES ($1, 'Hi', now(), 'fired')",
        [userA],
      ),
    ).rejects.toThrow();
  });

  it("isolates users: A cannot see, change or delete B's reminders", async () => {
    const bId = await insertReminder(
      userB,
      "B's reminder",
      "2026-11-26T03:30:00Z",
    );
    await setTestUser(db, userA);
    const seen = await callAs<{ id: string }>(
      db,
      "authenticated",
      "SELECT id FROM reminders",
    );
    expect(seen.rows.map((r) => r.id)).not.toContain(bId);
    const updated = await callAs(
      db,
      "authenticated",
      "UPDATE reminders SET status = 'cancelled' WHERE id = $1 RETURNING id",
      [bId],
    );
    expect(updated.rows).toHaveLength(0);
    const deleted = await callAs(
      db,
      "authenticated",
      "DELETE FROM reminders WHERE id = $1 RETURNING id",
      [bId],
    );
    expect(deleted.rows).toHaveLength(0);
    const stillThere = await db.query<{ status: string }>(
      "SELECT status FROM reminders WHERE id = $1",
      [bId],
    );
    expect(stillThere.rows).toHaveLength(1);
    expect(stillThere.rows[0].status).toBe("pending");
  });

  it("anon and authenticated cannot call claim_due_reminders", async () => {
    await expect(
      callAs(db, "anon", "SELECT * FROM claim_due_reminders(now())"),
    ).rejects.toThrow(/permission denied/);
    await expect(
      callAs(db, "authenticated", "SELECT * FROM claim_due_reminders(now())"),
    ).rejects.toThrow(/permission denied/);
  });

  it("claims due rows and leaves future rows pending", async () => {
    const dueId = await insertReminder(
      userA,
      "Due",
      "2026-11-25T03:00:00Z",
    );
    await insertReminder(userA, "Future", "2026-11-26T03:30:00Z");
    const claimed = await claim("2026-11-25T03:00:00Z");
    expect(claimed.map((r) => r.id)).toEqual([dueId]);
    expect(claimed[0].status).toBe("sending");
    const rows = await db.query<{ id: string; status: string }>(
      "SELECT id, status FROM reminders ORDER BY remind_at",
    );
    expect(rows.rows).toEqual([
      { id: dueId, status: "sending" },
      { id: expect.any(String), status: "pending" },
    ]);
  });

  it("a second claim finds nothing — no double delivery", async () => {
    await insertReminder(userA, "Due", "2026-11-25T03:00:00Z");
    expect((await claim("2026-11-25T03:00:00Z"))).toHaveLength(1);
    expect(await claim("2026-11-25T03:00:00Z")).toHaveLength(0);
  });

  it("reclaims a sending row abandoned more than 10 minutes ago", async () => {
    const id = await insertReminder(
      userA,
      "Stuck",
      "2026-11-25T03:00:00Z",
      "sending",
    );
    // The row was just claimed (updated_at is now, set by the
    // trigger). Claiming 11 minutes later must reclaim it: the run
    // that claimed it is dead by then.
    const later = new Date(Date.now() + 11 * 60 * 1000).toISOString();
    const claimed = await claim(later);
    expect(claimed.map((r) => r.id)).toEqual([id]);
  });

  it("does not reclaim a sending row abandoned less than 10 minutes ago", async () => {
    const id = await insertReminder(
      userA,
      "In flight",
      "2026-11-25T03:00:00Z",
      "sending",
    );
    // Claiming 9 minutes later: the run that claimed it may still
    // be alive, so the row stays claimed.
    const sooner = new Date(Date.now() + 9 * 60 * 1000).toISOString();
    expect(await claim(sooner)).toHaveLength(0);
    const row = await db.query<{ status: string }>(
      "SELECT status FROM reminders WHERE id = $1",
      [id],
    );
    expect(row.rows[0].status).toBe("sending");
  });
});
