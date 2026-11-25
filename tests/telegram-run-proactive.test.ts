// Proactive runner tests (Phase 3): real state in, nudges out —
// deduped, logged, bounded by quiet hours and the off switch.
// The Telegram send is a stub; the admin client is the in-memory
// fake from tests/telegram-helpers.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { runProactiveCheck } from "@/lib/telegram/run-proactive";
import type { TelegramSendResult } from "@/lib/telegram/client";
import { usageDateToday } from "@/lib/config";
import {
  createFakeAdmin,
  createFakeDb,
  FAKE_OWNER_ID,
  type FakeDb,
} from "./telegram-helpers";

function overdueTask(id: string, title: string, due: string) {
  return {
    id,
    title,
    due_date: `${due}T00:00:00+05:30`,
    status: "pending",
    created_at: "2026-11-20T00:00:00.000Z",
    updated_at: "2026-11-20T00:00:00.000Z",
    user_id: FAKE_OWNER_ID,
  };
}

/** 09:30 IST — outside quiet hours. */
const DAYTIME = () => new Date("2026-11-25T04:00:00Z");
/** 23:30 IST — inside quiet hours. */
const NIGHT = () => new Date("2026-11-25T18:00:00Z");

function runner(db: FakeDb, now: () => Date = DAYTIME) {
  const sent: string[] = [];
  const send = vi.fn(async (text: string): Promise<TelegramSendResult> => {
    sent.push(text);
    return { ok: true as const, chunks: 1 };
  });
  return {
    sent,
    send,
    run: () =>
      runProactiveCheck({
        admin: createFakeAdmin(db) as unknown as SupabaseClient<Database>,
        token: "token-123",
        ownerTelegramId: "123456789",
        now,
        send,
      }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runProactiveCheck", () => {
  it("sends a nudge for a real overdue task and records + logs it", async () => {
    const db = createFakeDb({
      tasks: [overdueTask("t1", "Pay caution money", "2026-11-20")],
    });
    const { run, sent, send } = runner(db);
    const result = await run();
    expect(result.status).toBe("sent");
    expect(result.sent).toEqual(["overdue:t1:2026-11-20"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sent[0]).toContain("Pay caution money");
    expect(sent[0]).toContain("2026-11-20");
    // Dedupe record + activity log row.
    expect(db.telegram_nudges).toHaveLength(1);
    expect(db.telegram_nudges[0].nudge_key).toBe("overdue:t1:2026-11-20");
    expect(db.telegram_nudges[0].user_id).toBe(FAKE_OWNER_ID);
    expect(db.action_logs).toHaveLength(1);
    expect(db.action_logs[0].tool_name).toBe("telegram_proactive");
    expect(db.action_logs[0].execution_status).toBe("succeeded");
  });

  it("never sends the same nudge twice", async () => {
    const db = createFakeDb({
      tasks: [overdueTask("t1", "Pay caution money", "2026-11-20")],
    });
    const first = runner(db);
    expect((await first.run()).status).toBe("sent");
    const second = runner(db);
    const result = await second.run();
    expect(result.status).toBe("none");
    expect(result.sent).toEqual([]);
    expect(second.send).not.toHaveBeenCalled();
    expect(db.telegram_nudges).toHaveLength(1);
  });

  it("sends nothing when nothing is due", async () => {
    const db = createFakeDb({ tasks: [] });
    const { run, send } = runner(db);
    const result = await run();
    expect(result.status).toBe("none");
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing during quiet hours", async () => {
    const db = createFakeDb({
      tasks: [overdueTask("t1", "Pay caution money", "2026-11-20")],
    });
    const { run, send } = runner(db, NIGHT);
    const result = await run();
    expect(result.status).toBe("quiet");
    expect(send).not.toHaveBeenCalled();
    expect(db.telegram_nudges).toHaveLength(0);
  });

  it("sends nothing when the owner turned nudges off with /stop", async () => {
    const db = createFakeDb({
      tasks: [overdueTask("t1", "Pay caution money", "2026-11-20")],
      settings: [
        { user_id: FAKE_OWNER_ID, telegram_proactive_enabled: false },
      ],
    });
    const { run, send } = runner(db);
    const result = await run();
    expect(result.status).toBe("disabled");
    expect(send).not.toHaveBeenCalled();
  });

  it("is inert (no crash, no send) when the token is missing", async () => {
    const db = createFakeDb({
      tasks: [overdueTask("t1", "Pay caution money", "2026-11-20")],
    });
    const result = await runProactiveCheck({
      admin: createFakeAdmin(db) as unknown as SupabaseClient<Database>,
      token: null,
      ownerTelegramId: "123456789",
      now: DAYTIME,
      send: async () => ({ ok: true, chunks: 1 }),
    });
    expect(result.status).toBe("not_configured");
  });

  it("logs a failed send and retries it next run (no dedupe row)", async () => {
    const db = createFakeDb({
      tasks: [overdueTask("t1", "Pay caution money", "2026-11-20")],
    });
    const failing = runner(db);
    failing.send.mockResolvedValueOnce({
      ok: false as const,
      error: "telegram_send_failed: Forbidden",
    });
    const first = await failing.run();
    expect(first.status).toBe("none");
    expect(first.sent).toEqual([]);
    expect(db.telegram_nudges).toHaveLength(0);
    expect(db.action_logs).toHaveLength(1);
    expect(db.action_logs[0].execution_status).toBe("failed");

    const retry = runner(db);
    const second = await retry.run();
    expect(second.status).toBe("sent");
    expect(db.telegram_nudges).toHaveLength(1);
  });

  it("nudges a task due today (key uses today's real date)", async () => {
    const today = usageDateToday();
    const db = createFakeDb({
      tasks: [overdueTask("t1", "IASc deadline", today)],
    });
    const { run, sent } = runner(db);
    const result = await run();
    expect(result.status).toBe("sent");
    expect(result.sent[0]).toContain("due-today:");
    expect(sent[0]).toContain("Due today");
  });
});
