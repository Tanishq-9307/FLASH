// Silent web research route tests (2026-11-24): the chat route runs
// one background Tavily search before answering when the question
// needs current/external information, feeds the findings to the
// model as context (never into the transcript), counts it on the
// monthly search meter, logs it in the activity log, and marks the
// reply with a data-researched part. The model is mocked like
// tests/chat-route.test.ts; the mocked admin rpc runs the real
// record_search / refund_search / log_read_only_action functions
// against a fresh PGlite database.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import {
  activityRows,
  callAs,
  createTestDb,
  createTestUser,
  deleteTestUser,
  searchCount,
  setTestUser,
  usageCount,
} from "./db/helpers";

// Hoisted holders: vi.mock factories run before imports, so shared mutable
// state must live in vi.hoisted.
const testState = vi.hoisted(() => ({
  db: null as PGlite | null,
  user: null as { id: string } | null,
  modelCalls: 0,
  modelMode: "ok" as "ok" | "error429",
  backupCalls: 0,
  lastPrompt: null as unknown,
  lastGroqModelId: null as unknown,
  searchCalls: 0,
  searchMode: "ok" as "ok" | "empty" | "error" | "misconfigured",
}));

// Tavily is mocked: the mode decides what a search returns. The real
// TavilyError class is kept so the route's misconfigured-key branch
// (instanceof) still works.
vi.mock("@/lib/search/tavily", async () => {
  const actual = await vi.importActual<typeof import("@/lib/search/tavily")>(
    "@/lib/search/tavily",
  );
  return {
    ...actual,
    searchTavily: async () => {
      testState.searchCalls += 1;
      if (testState.searchMode === "empty") return { results: [] };
      if (testState.searchMode === "error") {
        throw new Error("tavily 500");
      }
      if (testState.searchMode === "misconfigured") {
        throw new actual.TavilyError(
          "provider-misconfigured",
          "TAVILY_API_KEY is not set.",
        );
      }
      return {
        results: [
          {
            title: "ISRO launches new satellite",
            url: "https://example.com/isro",
            content: "ISRO launched a satellite today.",
            score: 0.9,
          },
          {
            title: "Second report",
            url: "https://example.com/second",
            content: "More detail here.",
            score: 0.8,
          },
        ],
      };
    },
  };
});

vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => {
    const { callAs: runAs } = await import("./db/helpers");
    // Minimal supabase-js query builder: only the methods the route uses
    // (insert/select/eq/order/single/textSearch/limit), executed as
    // `authenticated` so RLS applies exactly as it does for a real browser
    // client. textSearch/limit exist for the document-page retrieval
    // (M5-4) the document-question test exercises.
    class MockBuilder {
      private op: "select" | "insert" = "select";
      private columns = "*";
      private selectAfterInsert = false;
      private insertValues: Record<string, unknown> | null = null;
      private filters: Array<{ col: string; value: unknown }> = [];
      private orderings: Array<{ col: string; ascending: boolean }> = [];
      private singleRow = false;
      private textSearchFilter: { col: string; query: string } | null = null;
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

      textSearch(col: string, query: string): this {
        this.textSearchFilter = { col, query };
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
        let where = this.filters.length
          ? " WHERE " +
            this.filters
              .map((f) => {
                params.push(f.value);
                return `"${f.col}" = $${params.length}`;
              })
              .join(" AND ")
          : "";
        if (this.textSearchFilter) {
          params.push(this.textSearchFilter.query);
          where +=
            (where ? " AND " : " WHERE ") +
            `"${this.textSearchFilter.col}" @@ plainto_tsquery('english', $${params.length})`;
        }
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
      if (fn === "record_search") {
        const r = await db.query("SELECT * FROM record_search($1)", [
          args.p_user_id,
        ]);
        return { data: r.rows, error: null };
      }
      if (fn === "refund_search") {
        await db.query("SELECT refund_search($1, $2)", [
          args.p_user_id,
          args.p_usage_date,
        ]);
        return { data: null, error: null };
      }
      if (fn === "log_read_only_action") {
        const r = await db.query(
          "SELECT log_read_only_action($1, $2, $3, $4, $5, $6, $7)",
          [
            args.p_user_id,
            args.p_conversation_id,
            args.p_tool_call_id,
            args.p_tool,
            JSON.stringify(args.p_params),
            args.p_status,
            JSON.stringify(args.p_result),
          ],
        );
        return { data: r.rows, error: null };
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

vi.mock("@ai-sdk/groq", async () => {
  const { MockLanguageModelV4, simulateReadableStream } = await import("ai/test");
  return {
    groq: (modelId: unknown) => {
      testState.lastGroqModelId = modelId;
      testState.modelCalls += 1;
      if (testState.modelMode === "error429") {
        const err = new Error("provider 429 rate limited") as Error & {
          statusCode: number;
        };
        err.statusCode = 429;
        return new MockLanguageModelV4({
          doStream: async (options) => {
            testState.lastPrompt = options.prompt;
            throw err;
          },
        });
      }
      return new MockLanguageModelV4({
        doStream: async (options) => {
          testState.lastPrompt = options.prompt;
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

vi.mock("@openrouter/ai-sdk-provider", async () => {
  const { MockLanguageModelV4, simulateReadableStream } = await import("ai/test");
  return {
    createOpenRouter: () => () => {
      return new MockLanguageModelV4({
        doStream: async () => {
          testState.backupCalls += 1;
          const chunks: import("@ai-sdk/provider").LanguageModelV4StreamPart[] = [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Hello from OpenRouter" },
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
import { CODING_MODEL_ID } from "@/lib/ai/provider";

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

const bodyFor = (text: string, conversationId: string | null = null, extra: Record<string, unknown> = {}) => ({
  conversationId,
  message: userMessage("m1", text),
  ...extra,
});

/** The full prompt (system + messages) the model was actually given. */
function promptText(): string {
  return JSON.stringify(testState.lastPrompt ?? []);
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function storedMessages(db: PGlite): Promise<
  Array<{ role: string; content: string; parts: unknown }>
> {
  return waitFor(async () => {
    const r = await db.query<{ role: string; content: string; parts: unknown }>(
      "SELECT role, content, parts FROM messages ORDER BY created_at ASC, id ASC",
    );
    return r.rows.length > 0 ? r.rows : null;
  });
}

async function conversationIdFor(db: PGlite, userId: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    "SELECT id FROM conversations WHERE user_id = $1",
    [userId],
  );
  return r.rows[0].id;
}

describe("POST /api/chat — silent web research", () => {
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
    await setTestUser(db, userId);
    testState.user = { id: userId };
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
  });

  afterEach(async () => {
    await deleteTestUser(db, userId);
    testState.user = null;
    testState.modelCalls = 0;
    testState.modelMode = "ok";
    testState.backupCalls = 0;
    testState.lastPrompt = null;
    testState.lastGroqModelId = null;
    testState.searchCalls = 0;
    testState.searchMode = "ok";
    vi.unstubAllEnvs();
  });

  it("researches a current-facts question: counted, logged, fed to the model, indicator on the reply", async () => {
    const res = await POST(chatRequest(bodyFor("What is the latest ISRO news today?")));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Hello");
    // The indicator travels as a data part, with the real sources.
    expect(body).toContain("data-researched");
    expect(body).toContain("https://example.com/isro");
    // The findings reached the model as context — inside the
    // delimited untrusted block — but were NOT pasted into the
    // transcript: the stream carries no finding text.
    expect(promptText()).toContain("ISRO launched a satellite today.");
    expect(promptText()).toContain("=== UNTRUSTED DATA START ===");
    expect(body).not.toContain("ISRO launched a satellite today.");
    // Usage: one model call, one search on the shared monthly meter.
    expect(await usageCount(db, userId)).toBe(1);
    expect(await searchCount(db, userId)).toBe(1);
    expect(testState.searchCalls).toBe(1);
    // Activity log: one row, tool web_search, mode silent, with the
    // query, the result count, and the conversation.
    const rows = await activityRows(db, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe("web_search");
    expect(rows[0].execution_status).toBe("succeeded");
    const params = rows[0].parameters as Record<string, unknown>;
    expect(params.query).toBe("What is the latest ISRO news today?");
    expect(params.mode).toBe("silent");
    expect(rows[0].tool_call_id).toMatch(/^silent-/);
    const result = rows[0].result_payload as Record<string, unknown>;
    expect(result.resultCount).toBe(2);
    expect(rows[0].conversation_id).toBe(await conversationIdFor(db, userId));
    // The persisted reply carries the researched flag (with sources)
    // in parts, and its text is just the reply.
    const messages = await storedMessages(db);
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("Hello");
    const parts = messages[1].parts as Record<string, unknown>;
    expect(parts.researched).toBe(true);
    expect(parts.sources).toEqual([
      { title: "ISRO launches new satellite", url: "https://example.com/isro" },
      { title: "Second report", url: "https://example.com/second" },
    ]);
  });

  it("skips research for a greeting: no search, no log, no indicator", async () => {
    const res = await POST(chatRequest(bodyFor("hello")));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Hello");
    expect(body).not.toContain("data-researched");
    expect(await searchCount(db, userId)).toBe(0);
    expect(testState.searchCalls).toBe(0);
    expect(await activityRows(db, userId)).toHaveLength(0);
    const messages = await storedMessages(db);
    expect(messages[1].parts).toBeNull();
  });

  it("skips research for a question about the owner's own data", async () => {
    const res = await POST(
      chatRequest(bodyFor("What did I note about the robot arm?")),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("data-researched");
    expect(await searchCount(db, userId)).toBe(0);
    expect(testState.searchCalls).toBe(0);
  });

  it("skips research for a general-knowledge question", async () => {
    const res = await POST(
      chatRequest(bodyFor("What is the capital of France?")),
    );
    expect(res.status).toBe(200);
    expect(await searchCount(db, userId)).toBe(0);
    expect(testState.searchCalls).toBe(0);
  });

  it("missing key: no crash, no indicator, no search counted", async () => {
    vi.stubEnv("TAVILY_API_KEY", "");
    const res = await POST(chatRequest(bodyFor("What is the latest ISRO news today?")));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Hello");
    expect(body).not.toContain("data-researched");
    expect(await searchCount(db, userId)).toBe(0);
    expect(testState.searchCalls).toBe(0);
    expect(await activityRows(db, userId)).toHaveLength(0);
  });

  it("empty results: the search is counted and logged, but the reply is not marked researched", async () => {
    testState.searchMode = "empty";
    const res = await POST(chatRequest(bodyFor("What is the latest ISRO news today?")));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Hello");
    expect(body).not.toContain("data-researched");
    expect(await searchCount(db, userId)).toBe(1);
    const rows = await activityRows(db, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].execution_status).toBe("succeeded");
    expect((rows[0].result_payload as Record<string, unknown>).resultCount).toBe(0);
    const messages = await storedMessages(db);
    expect(messages[1].parts).toBeNull();
  });

  it("provider failure: the reply still arrives, the search stays counted, the log says failed, no indicator", async () => {
    testState.searchMode = "error";
    const res = await POST(chatRequest(bodyFor("What is the latest ISRO news today?")));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Hello");
    expect(body).not.toContain("data-researched");
    expect(await searchCount(db, userId)).toBe(1);
    const rows = await activityRows(db, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].execution_status).toBe("failed");
    expect(promptText()).not.toContain("ISRO launched a satellite today.");
  });

  it("missing key at dispatch refunds the record and marks nothing", async () => {
    testState.searchMode = "misconfigured";
    const res = await POST(chatRequest(bodyFor("What is the latest ISRO news today?")));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("data-researched");
    // The pre-dispatch abort refunds: no search counted.
    expect(await searchCount(db, userId)).toBe(0);
    const rows = await activityRows(db, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].execution_status).toBe("failed");
  });

  it("a document question never researches, even with recency words", async () => {
    const docId = randomUUID();
    await setTestUser(db, userId);
    await callAs(
      db,
      "authenticated",
      `INSERT INTO documents (id, title, storage_path, size_bytes) VALUES ($1, 'Test doc', $2, 100)`,
      [docId, `${userId}/${docId}.pdf`],
    );
    await callAs(
      db,
      "service_role",
      "SELECT save_document_extraction($1, $2, 'ready', $3, NULL)",
      [
        userId,
        docId,
        JSON.stringify([
          { page: 1, text: "The quarterly budget is five thousand rupees." },
        ]),
      ],
    );
    await setTestUser(db, userId);
    const res = await POST(
      chatRequest({
        conversationId: null,
        message: userMessage("m1", "What is the latest budget figure?"),
        documentId: docId,
      }),
    );
    expect(res.status).toBe(200);
    expect(await searchCount(db, userId)).toBe(0);
    expect(testState.searchCalls).toBe(0);
  });

  it("coding mode still researches, and runs the coding model", async () => {
    const res = await POST(
      chatRequest(
        bodyFor("What is the latest ISRO news today?", null, { codingMode: true }),
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("data-researched");
    expect(body).toContain(CODING_MODEL_ID);
    expect(testState.lastGroqModelId).toBe(CODING_MODEL_ID);
    expect(await searchCount(db, userId)).toBe(1);
  });

  it("hot-swap still works: a 429 fails over to the backup and research ran once", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    testState.modelMode = "error429";
    const res = await POST(chatRequest(bodyFor("What is the latest ISRO news today?")));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Hello from OpenRouter");
    expect(body).toContain("data-researched");
    expect(testState.backupCalls).toBe(1);
    expect(await searchCount(db, userId)).toBe(1);
    expect(testState.searchCalls).toBe(1);
  });

  it("regenerate researches the last user message — at most one search per turn", async () => {
    // Regenerate is only valid when the last message is the user's:
    // seed a conversation with one user message, as the existing
    // chat-route regenerate test does.
    const conv = await callAs<{ id: string }>(
      db,
      "authenticated",
      "INSERT INTO conversations (title) VALUES ('Seed') RETURNING id",
    );
    const conversationId = conv.rows[0].id;
    await callAs(
      db,
      "authenticated",
      "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', 'What is the latest ISRO news today?')",
      [conversationId],
    );
    const first = await POST(
      chatRequest({ conversationId, regenerate: true }),
    );
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("data-researched");
    expect(await searchCount(db, userId)).toBe(1);
    // A second user message, then a second regenerate: research runs
    // once more for the new turn — one search per turn, never more.
    await callAs(
      db,
      "authenticated",
      "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', 'What is the latest ISRO news today?')",
      [conversationId],
    );
    const second = await POST(
      chatRequest({ conversationId, regenerate: true }),
    );
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("data-researched");
    expect(await searchCount(db, userId)).toBe(2);
  });

  it("a follow-up turn after a researched reply works — the data part does not break history", async () => {
    const first = await POST(chatRequest(bodyFor("What is the latest ISRO news today?")));
    expect(first.status).toBe(200);
    await first.text();
    const conversationId = await conversationIdFor(db, userId);
    const second = await POST(
      chatRequest(bodyFor("thanks, that helps", conversationId)),
    );
    expect(second.status).toBe(200);
    const body = await second.text();
    expect(body).toContain("Hello");
    expect(body).not.toContain("data-researched");
    // The second turn did not research, and the first turn's search
    // is still the only one counted.
    expect(await searchCount(db, userId)).toBe(1);
    expect(testState.modelCalls).toBe(2);
  });
});
