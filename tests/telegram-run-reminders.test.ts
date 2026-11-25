// Reminder delivery tests (Phase 3): due reminders go out, future
// ones wait, a failed send releases the row for the next run — and,
// the rule that sets reminders apart from nudges, quiet hours do
// NOT stop a reminder: the owner asked for that exact time.
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { runRemindersCheck } from "@/lib/telegram/run-reminders";
import type { TelegramSendResult } from "@/lib/telegram/client";
import {
  createFakeAdmin,
  createFakeDb,
  FAKE_OWNER_ID,
  type FakeDb,
} from "./telegram-helpers";

/** 09:30 IST — outside quiet hours. */
const DAYTIME = () => new Date("2026-11-25T04:00:00Z");
/** 02:30 IST — deep inside quiet hours (23:00–07:00). */
const NIGHT = () => new Date("2026-11-24T21:00:00Z");

function reminder(id: string, message: string, remindAt: string) {
  return {
    id,
    user_id: FAKE_OWNER_ID,
    message,
    remind_at: remindAt,
    status: "pending",
    source: "telegram",
    sent_at: null,
    created_at: "2026-11-24T20:00:00.000Z",
    updated_at: "2026-11-24T20:00:00.000Z",
  };
}

function runner(
  db: FakeDb,
  now: () => Date = DAYTIME,
  sendImpl?: (text: string) => Promise<TelegramSendResult>,
) {
  const sent: string[] = [];
  const send = vi.fn(
    sendImpl ??
      (async (text: string): Promise<TelegramSendResult> => {
        sent.push(text);
        return { ok: true as const, chunks: 1 };
      }),
  );
  return {
    sent,
    send,
    run: (overrides: { token?: string | null; ownerTelegramId?: string | null } = {}) =>
      runRemindersCheck({
        admin: createFakeAdmin(db) as unknown as SupabaseClient<Database>,
        token: overrides.token === undefined ? "<redacted>" : overrides.token,
        ownerTelegramId:
          overrides.ownerTelegramId === undefined
            ? "123456789"
            : overrides.ownerTelegramId,
        now,
        send,
      }),
  };
}

describe("runRemindersCheck", () => {
  it("sends a due reminder, marks it sent, and logs the delivery", async () => {
    const db = createFakeDb({
      reminders: [reminder("r1", "Submit the form", "2026-11-25T03:30:00Z")],
    });
    const r = runner(db);
    const result = await r.run();
    expect(result.status).toBe("sent");
    expect(result.sent).toEqual(["r1"]);
    expect(r.sent).toEqual(["⏰ Reminder: Submit the form"]);
    expect(db.reminders[0].status).toBe("sent");
    expect(db.reminders[0].sent_at).not.toBeNull();
    const log = db.action_logs.find(
      (row) => row.tool_name === "telegram_reminder",
    );
    expect(log).toBeDefined();
    expect(log?.execution_status).toBe("succeeded");
  });

  it("fires at the set time even inside quiet hours", async () => {
    const db = createFakeDb({
      reminders: [reminder("r1", "Call the lab", "2026-11-24T21:00:00Z")],
    });
    const r = runner(db, NIGHT);
    const result = await r.run();
    expect(result.status).toBe("sent");
    expect(r.sent).toEqual(["⏰ Reminder: Call the lab"]);
  });

  it("sends nothing when nothing is due", async () => {
    const db = createFakeDb({
      reminders: [reminder("r1", "Future", "2026-11-26T03:30:00Z")],
    });
    const r = runner(db);
    const result = await r.run();
    expect(result.status).toBe("none");
    expect(result.sent).toEqual([]);
    expect(r.send).not.toHaveBeenCalled();
    expect(db.reminders[0].status).toBe("pending");
  });

  it("does not send the same reminder twice across runs", async () => {
    const db = createFakeDb({
      reminders: [reminder("r1", "Submit the form", "2026-11-25T03:30:00Z")],
    });
    const r = runner(db);
    await r.run();
    const second = await r.run();
    expect(second.status).toBe("none");
    expect(r.send).toHaveBeenCalledTimes(1);
  });

  it("releases a reminder back to pending when the send fails, and retries it", async () => {
    const db = createFakeDb({
      reminders: [reminder("r1", "Submit the form", "2026-11-25T03:30:00Z")],
    });
    let fail = true;
    const r = runner(db, DAYTIME, async () => {
      if (fail) return { ok: false as const, error: "telegram_send_failed: boom" };
      return { ok: true as const, chunks: 1 };
    });
    const first = await r.run();
    expect(first.status).toBe("none");
    expect(first.sent).toEqual([]);
    expect(db.reminders[0].status).toBe("pending");
    expect(db.reminders[0].sent_at).toBeNull();
    const failedLog = db.action_logs.find(
      (row) => row.tool_name === "telegram_reminder",
    );
    expect(failedLog?.execution_status).toBe("failed");

    fail = false;
    const second = await r.run();
    expect(second.status).toBe("sent");
    expect(second.sent).toEqual(["r1"]);
    expect(db.reminders[0].status).toBe("sent");
  });

  it("is inert when not configured", async () => {
    const db = createFakeDb({
      reminders: [reminder("r1", "Submit the form", "2026-11-25T03:30:00Z")],
    });
    const r = runner(db);
    expect((await r.run({ token: null })).status).toBe("not_configured");
    expect((await r.run({ ownerTelegramId: null })).status).toBe(
      "not_configured",
    );
    expect(r.send).not.toHaveBeenCalled();
  });

  it("sends nothing when the owner cannot be resolved", async () => {
    const db = createFakeDb({
      users: [],
      reminders: [reminder("r1", "Submit the form", "2026-11-25T03:30:00Z")],
    });
    const r = runner(db);
    expect((await r.run()).status).toBe("owner_not_found");
    expect(r.send).not.toHaveBeenCalled();
  });
});
