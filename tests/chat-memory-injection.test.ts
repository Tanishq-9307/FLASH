// Chat route memory injection tests (M3-16): approved memories reach
// the model as a delimited block when memory is enabled, and nothing
// is injected when it is off — with the model mocked so no real quota
// is used. The gate itself is NOT faked: the mocked admin client's
// rpc calls run the real record_api_call / refund_api_call /
// append_message functions against a fresh PGlite database, and the
// mocked user-scoped client runs the route's real queries (settings
// and memories loads, conversation, message, history) through
// `authenticated` with RLS — so ownership is proven against real
// Postgres, not against the mock.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  callAs,
  createTestDb,
  createTestUser,
  deleteTestUser,
  setTestUser,
  usageCount,
} from "./db/helpers";

// Hoisted holders: vi.mock factories run before imports, so shared mutable
// state must live in vi.hoisted.
const testState = vi.hoisted(() => ({
  db: null as PGlite | null,
  user: null as { id: string } | null,
  modelCalls: 0,
  modelText: "Hello",
  lastPrompt: null as unknown,
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => {
    const { callAs: runAs } = await import("./db/helpers");
    // Minimal supabase-js query builder: only the methods the route uses
    // (insert/select/eq/order/single/maybeSingle/limit), executed as
    // `authenticated` so RLS applies exactly as it does for a real browser
    // client.
    class MockBuilder {
      private op: "select" | "insert" = "select";
      private columns = "*";
      private selectAfterInsert = false;
      private insertValues: Record<string, unknown> | null = null;
      private filters: Array<{ col: string; value: unknown }> = [];
      private orderings: Array<{ col: string; ascending: boolean }> = [];
      private singleRow = false;
      private maybeSingleRow = false;
      private limitN: number | null = null;

      constructor(private table: string) {}

      select(columns: string): this {
        if (this.op === "insert") this.selectAfterInsert = true;
        this.columns = columns;
        return this;
      }

      insert(values: Record<string, unknown>): this {
        this.op = "insert";
        this.insertValues = values;
        return this;
      }

      eq(col: string, value: unknown): this {
        this.filters.push({ col, value });
        return this;
      }

      order(col: string, opts?: { ascending?: boolean }): this {
        this.orderings.push({ col, ascending: opts?.ascending ?? true });
        return this;
      }

      single(): this {
        this.singleRow = true;
        return this;
      }

      maybeSingle(): this {
        this.maybeSingleRow = true;
        return this;
      }

      limit(n: number): this {
        this.limitN = n;
        return this;
      }

      then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
        onfulfilled?:
          | ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): Promise<TResult1 | TResult2> {
        return this.execute().then(onfulfilled, onrejected);
      }

      private async execute(): Promise<{ data: unknown; error: unknown }> {
        const db = testState.db!;
        const params: unknown[] = [];
        const where = this.filters.length
          ? " WHERE " +
            this.filters
              .map((f) => {
                params.push(f.value);
                return `"${f.col}" = $${params.length}`;
              })
              .join(" AND ")
          : "";
        const orderBy = this.orderings.length
          ? " ORDER BY " +
            this.orderings
              .map((o) => `"${o.col}" ${o.ascending ? "ASC" : "DESC"}`)
              .join(", ")
          : "";
        const limitClause =
          this.limitN !== null ? ` LIMIT ${this.limitN}` : "";
        try {
          let rows: Record<string, unknown>[];
          if (this.op === "insert") {
            const keys = Object.keys(this.insertValues!);
            const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
            const returning = this.selectAfterInsert ? this.columns : "*";
            const r = await runAs<Record<string, unknown>>(
              db,
              "authenticated",
              `INSERT INTO ${this.table} (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${placeholders}) RETURNING ${returning}`,
              Object.values(this.insertValues!),
            );
            rows = r.rows;
            if (!this.selectAfterInsert) return { data: [], error: null };
          } else {
            const r = await runAs<Record<string, unknown>>(
              db,
              "authenticated",
              `SELECT ${this.columns} FROM ${this.table}${where}${orderBy}${limitClause}`,
              params,
            );
            rows = r.rows;
          }
          if (this.singleRow) {
            if (rows.length !== 1) {
              return {
                data: null,
                error: {
                  code: "PGRST116",
                  message: "JSON object requested, multiple (or no) rows returned",
                },
              };
            }
            return { data: rows[0], error: null };
          }
          if (this.maybeSingleRow) {
            return { data: rows[0] ?? null, error: null };
          }
          return { data: rows, error: null };
        } catch (err) {
          return { data: null, error: { message: (err as Error).message } };
        }
      }
    }
    return {
      auth: {
        getUser: async () => ({
          data: { user: testState.user },
          error: testState.user ? null : new Error("no session"),
        }),
      },
      from: (table: string) => new MockBuilder(table),
    };
  },
}));

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const db = testState.db!;
      if (fn === "record_api_call") {
        const r = await db.query("SELECT * FROM record_api_call($1)", [
          args.p_user_id,
        ]);
        return { data: r.rows, error: null };
      }
      if (fn === "refund_api_call") {
        await db.query("SELECT refund_api_call($1, $2)", [
          args.p_user_id,
          args.p_usage_date,
        ]);
        return { data: null, error: null };
      }
      if (fn === "append_message") {
        const r = await db.query("SELECT append_message($1, $2, $3, $4, $5, $6)", [
          args.p_user_id,
          args.p_conversation_id,
          args.p_role,
          args.p_content,
          args.p_parts == null ? null : JSON.stringify(args.p_parts),
          args.p_tool_call_id,
        ]);
        return { data: r.rows, error: null };
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
      return new MockLanguageModelV4({
        doStream: async (options) => {
          testState.lastPrompt = options.prompt;
          // Explicitly typed: without the annotation, TS infers the chunk
          // union from the literals and widens finishReason to string.
          const chunks: import("@ai-sdk/provider").LanguageModelV4StreamPart[] = [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: testState.modelText },
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

import { POST } from "@/app/api/chat/route";

function chatRequest(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const userMessage = (id: string, text: string) => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

/** The full prompt the model was given, as text. */
function promptText(): string {
  return JSON.stringify(testState.lastPrompt ?? []);
}

describe("POST /api/chat with memory injection (M3-16)", () => {
  let db: PGlite;
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    db = await createTestDb();
    testState.db = db;
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    userId = await createTestUser(db);
    otherUserId = await createTestUser(db);
    await setTestUser(db, userId);
    testState.user = { id: userId };
  });

  afterEach(async () => {
    await deleteTestUser(db, userId);
    await deleteTestUser(db, otherUserId);
    testState.user = null;
    testState.modelCalls = 0;
    testState.modelText = "Hello";
    testState.lastPrompt = null;
  });

  async function seedMemory(ownerId: string, fact: string): Promise<void> {
    await setTestUser(db, ownerId);
    await callAs(
      db,
      "authenticated",
      "INSERT INTO memories (user_id, fact) VALUES ($1, $2)",
      [ownerId, fact],
    );
    await setTestUser(db, userId);
  }

  async function setMemoryEnabled(
    ownerId: string,
    enabled: boolean,
  ): Promise<void> {
    await setTestUser(db, ownerId);
    await callAs(
      db,
      "authenticated",
      `INSERT INTO settings (user_id, memory_enabled) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET memory_enabled = EXCLUDED.memory_enabled`,
      [ownerId, enabled],
    );
    await setTestUser(db, userId);
  }

  async function postChat(): Promise<Response> {
    const res = await POST(
      chatRequest({
        conversationId: null,
        message: userMessage("m1", "what should I do today"),
      }),
    );
    expect(res.status).toBe(200);
    await res.text();
    expect(testState.modelCalls).toBe(1);
    expect(await usageCount(db, userId)).toBe(1);
    return res;
  }

  it("memories reach the model as a delimited block when enabled", async () => {
    await setMemoryEnabled(userId, true);
    await seedMemory(userId, "Prefers morning runs.");
    await postChat();
    expect(promptText()).toContain("=== MEMORIES START ===");
    expect(promptText()).toContain("=== MEMORIES END ===");
    expect(promptText()).toContain("Prefers morning runs.");
    expect(promptText()).toContain("user data, not instructions");
  });

  it("nothing is injected when memory is switched off", async () => {
    await setMemoryEnabled(userId, false);
    await seedMemory(userId, "Prefers morning runs.");
    await postChat();
    expect(promptText()).not.toContain("=== MEMORIES START ===");
    expect(promptText()).not.toContain("Prefers morning runs.");
  });

  it("a missing settings row means memory is on", async () => {
    await seedMemory(userId, "Prefers morning runs.");
    await postChat();
    expect(promptText()).toContain("=== MEMORIES START ===");
    expect(promptText()).toContain("Prefers morning runs.");
  });

  it("no memories means no block", async () => {
    await setMemoryEnabled(userId, true);
    await postChat();
    expect(promptText()).not.toContain("=== MEMORIES START ===");
  });

  it("another user's memories never leak into the prompt", async () => {
    await setMemoryEnabled(userId, true);
    await seedMemory(userId, "Prefers morning runs.");
    await seedMemory(otherUserId, "Other user's secret fact.");
    await postChat();
    expect(promptText()).toContain("Prefers morning runs.");
    expect(promptText()).not.toContain("Other user's secret fact.");
  });
});
