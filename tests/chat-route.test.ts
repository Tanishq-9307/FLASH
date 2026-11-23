// Chat route tests (M1-7): the Model Gate, with the model mocked so no real
// quota is used, and the Supabase clients mocked so no live project is
// needed. The gate itself is NOT faked: the mocked admin client's rpc calls
// run the real reserve_api_call / refund_api_call functions against a fresh
// PGlite database (the role enforcement those functions rely on was proven
// separately in tests/db/rate-limit.test.ts).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  callAs,
  createTestDb,
  createTestUser,
  deleteTestUser,
  usageCount,
} from "./db/helpers";

// Hoisted holders: vi.mock factories run before imports, so shared mutable
// state must live in vi.hoisted.
const testState = vi.hoisted(() => ({
  db: null as PGlite | null,
  user: null as { id: string } | null,
  modelCalls: 0,
  modelMode: "ok" as "ok" | "error",
  abortAfterReserve: null as (() => void) | null,
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: testState.user },
        error: testState.user ? null : new Error("no session"),
      }),
    },
  }),
}));

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const db = testState.db!;
      if (fn === "reserve_api_call") {
        const r = await db.query("SELECT * FROM reserve_api_call($1, $2)", [
          args.p_user_id,
          args.p_cap,
        ]);
        testState.abortAfterReserve?.();
        return { data: r.rows, error: null };
      }
      if (fn === "refund_api_call") {
        await db.query("SELECT refund_api_call($1, $2)", [
          args.p_user_id,
          args.p_usage_date,
        ]);
        return { data: null, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  }),
}));

vi.mock("@ai-sdk/google", async () => {
  const { MockLanguageModelV4, simulateReadableStream } = await import("ai/test");
  return {
    google: () => {
      testState.modelCalls += 1;
      if (testState.modelMode === "error") {
        return new MockLanguageModelV4({
          doStream: async () => {
            throw new Error("provider 503 overloaded");
          },
        });
      }
      return new MockLanguageModelV4({
        doStream: async () => {
          // Explicitly typed: without the annotation, TS infers the chunk
          // union from the literals and widens finishReason to string.
          const chunks: import("@ai-sdk/provider").LanguageModelV4StreamPart[] = [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Hello" },
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ];
          return { stream: simulateReadableStream({ chunks }) };
        },
      });
    },
  };
});

import { POST, maxDuration } from "@/app/api/chat/route";

function chatRequest(
  messages: unknown[],
  init: { signal?: AbortSignal } = {},
): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
    signal: init.signal,
  });
}

const userMessage = (id: string, text: string) => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

describe("POST /api/chat", () => {
  it("exports maxDuration 60 (carried over from the M0-5 stub)", () => {
    expect(maxDuration).toBe(60);
  });

  let db: PGlite;
  let userId: string;

  beforeAll(async () => {
    db = await createTestDb();
    testState.db = db;
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    userId = await createTestUser(db);
    testState.user = { id: userId };
  });

  afterEach(async () => {
    await deleteTestUser(db, userId);
    testState.user = null;
    testState.modelCalls = 0;
    testState.modelMode = "ok";
    testState.abortAfterReserve = null;
    delete process.env.DAILY_MODEL_CALL_CAP;
  });

  it("unauthenticated gets 401 and reserves nothing", async () => {
    testState.user = null;
    const res = await POST(chatRequest([userMessage("m1", "hi")]));
    expect(res.status).toBe(401);
    expect(await usageCount(db, userId)).toBe(0);
    expect(testState.modelCalls).toBe(0);
  });

  it("streams a reply and reserves one call", async () => {
    const res = await POST(chatRequest([userMessage("m1", "hi")]));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Hello");
    expect(await usageCount(db, userId)).toBe(1);
    expect(testState.modelCalls).toBe(1);
  });

  it("with cap 2 the third request gets 429 and no model call", async () => {
    process.env.DAILY_MODEL_CALL_CAP = "2";
    const first = await POST(chatRequest([userMessage("m1", "one")]));
    expect(first.status).toBe(200);
    await first.text();
    const second = await POST(chatRequest([userMessage("m2", "two")]));
    expect(second.status).toBe(200);
    await second.text();
    const third = await POST(chatRequest([userMessage("m3", "three")]));
    expect(third.status).toBe(429);
    const body = await third.json();
    expect(body.error).toBe("cap_reached");
    expect(body.cap).toBe(2);
    expect(await usageCount(db, userId)).toBe(2);
    expect(testState.modelCalls).toBe(2);
  });

  it("two parallel requests at cap minus one allow exactly one", async () => {
    process.env.DAILY_MODEL_CALL_CAP = "2";
    await callAs(db, "service_role", "SELECT * FROM reserve_api_call($1, 2)", [userId]);
    expect(await usageCount(db, userId)).toBe(1);
    const [a, b] = await Promise.all([
      POST(chatRequest([userMessage("m1", "first")])),
      POST(chatRequest([userMessage("m2", "second")])),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 429]);
    for (const res of [a, b]) await res.text();
    expect(await usageCount(db, userId)).toBe(2);
    expect(testState.modelCalls).toBe(1);
  });

  it("abort before dispatch refunds", async () => {
    const controller = new AbortController();
    // Abort at the precise moment between reserve and dispatch.
    testState.abortAfterReserve = () => controller.abort();
    const res = await POST(
      chatRequest([userMessage("m1", "hi")], { signal: controller.signal }),
    );
    expect(res.status).toBe(499);
    expect(await usageCount(db, userId)).toBe(0);
    expect(testState.modelCalls).toBe(0);
  });

  it("provider 5xx after dispatch does not refund", async () => {
    testState.modelMode = "error";
    const res = await POST(chatRequest([userMessage("m1", "hi")]));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"type":"error"');
    expect(await usageCount(db, userId)).toBe(1);
    expect(testState.modelCalls).toBe(1);
  });

  it("rejects an invalid body with 400 and reserves nothing", async () => {
    const empty = await POST(chatRequest([]));
    expect(empty.status).toBe(400);
    const tooLong = await POST(
      chatRequest([userMessage("m1", "x".repeat(8001))]),
    );
    expect(tooLong.status).toBe(400);
    expect(await usageCount(db, userId)).toBe(0);
    expect(testState.modelCalls).toBe(0);
  });
});
