// Reminders route tests (Phase 3): the scheduled endpoint only
// answers a caller presenting the cron secret. The delivery check
// itself is mocked — this file proves the gate, not the delivery.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { createFakeAdmin, createFakeDb } from "./telegram-helpers";

const state = vi.hoisted(() => ({
  checkCalls: 0,
}));

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () =>
    createFakeAdmin(createFakeDb()) as unknown as SupabaseClient<Database>,
}));

vi.mock("@/lib/telegram/run-reminders", () => ({
  runRemindersCheck: vi.fn(async () => {
    state.checkCalls += 1;
    return { status: "sent", sent: ["r1"], detail: "Sent 1 reminder(s)." };
  }),
}));

import { GET, POST } from "@/app/api/telegram/reminders/route";

function remindersRequest(
  method: "GET" | "POST",
  auth: string | null,
): Request {
  return new Request("http://localhost/api/telegram/reminders", {
    method,
    headers: auth === null ? {} : { Authorization: auth },
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = "cron-s3cr3t";
  state.checkCalls = 0;
});

afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.TELEGRAM_PROACTIVE_SECRET;
  vi.unstubAllEnvs();
});

describe("/api/telegram/reminders", () => {
  it("refuses every call with 503 when no cron secret is configured", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(remindersRequest("GET", "Bearer cron-s3cr3t"));
    expect(res.status).toBe(503);
    expect(state.checkCalls).toBe(0);
  });

  it("refuses a missing bearer token with 401", async () => {
    const res = await GET(remindersRequest("GET", null));
    expect(res.status).toBe(401);
    expect(state.checkCalls).toBe(0);
  });

  it("refuses a wrong bearer token with 401", async () => {
    const res = await POST(remindersRequest("POST", "Bearer wrong"));
    expect(res.status).toBe(401);
    expect(state.checkCalls).toBe(0);
  });

  it("runs the check on a correct bearer token (GET, as Vercel Cron sends)", async () => {
    const res = await GET(remindersRequest("GET", "Bearer cron-s3cr3t"));
    expect(res.status).toBe(200);
    expect(state.checkCalls).toBe(1);
    expect(await res.json()).toEqual({
      status: "sent",
      sent: ["r1"],
      detail: "Sent 1 reminder(s).",
    });
  });

  it("also accepts POST with the same secret (manual trigger)", async () => {
    const res = await POST(remindersRequest("POST", "Bearer cron-s3cr3t"));
    expect(res.status).toBe(200);
    expect(state.checkCalls).toBe(1);
    expect(await res.json()).toEqual({
      status: "sent",
      sent: ["r1"],
      detail: "Sent 1 reminder(s).",
    });
  });
});
