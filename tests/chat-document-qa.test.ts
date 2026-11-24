// Document Q&A route tests (M5-4): evidence-cited answers through the chat
// route, with the model mocked so no real quota is used. The gate itself is
// NOT faked: the mocked admin client's rpc calls run the real
// record_api_call / refund_api_call / append_message /
// save_document_extraction functions against a fresh PGlite database, and
// the mocked user-scoped client runs the route's real queries (document
// load, page retrieval, conversation, message, history) through
// `authenticated` with RLS — so ownership, retrieval, and citation
// verification are proven against real Postgres, not against the mock.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
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
    // (insert/select/eq/order/single/textSearch/limit), executed as
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

      textSearch(
        col: string,
        query: string,
        _opts?: { type?: string; config?: string },
      ): this {
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
      if (fn === "save_document_extraction") {
        const r = await db.query(
          "SELECT save_document_extraction($1, $2, $3, $4, $5)",
          [
            args.p_user_id,
            args.p_document_id,
            args.p_status,
            args.p_pages == null ? null : JSON.stringify(args.p_pages),
            args.p_error_code,
          ],
        );
        return { data: r.rows, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  }),
}));

vi.mock("@ai-sdk/groq", async () => {
  const { MockLanguageModelV4, simulateReadableStream } = await import("ai/test");
  return {
    groq: () => {
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

describe("POST /api/chat with documentId (M5-4)", () => {
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

  async function seedDocument(
    ownerId: string,
    status: "ready" | "processing",
    pages: Array<{ page: number; text: string }> | null,
  ): Promise<string> {
    const id = randomUUID();
    await setTestUser(db, ownerId);
    await callAs(
      db,
      "authenticated",
      `INSERT INTO documents (id, title, storage_path, size_bytes)
       VALUES ($1, 'Test doc', $2, 100)`,
      [id, `${ownerId}/${id}.pdf`],
    );
    if (status === "ready") {
      await callAs(
        db,
        "service_role",
        "SELECT save_document_extraction($1, $2, 'ready', $3, NULL)",
        [ownerId, id, JSON.stringify(pages)],
      );
    }
    await setTestUser(db, userId);
    return id;
  }

  async function storedMessages(): Promise<Array<{ role: string; content: string }>> {
    const rows = await waitFor(async () => {
      const r = await db.query<{ role: string; content: string }>(
        "SELECT role, content FROM messages ORDER BY created_at, id",
      );
      return r.rows.length > 0 ? r.rows : null;
    });
    return rows;
  }

  const budgetPages = [
    { page: 1, text: "The quarterly budget is five thousand rupees." },
    { page: 2, text: "Travel costs are capped at one thousand rupees." },
    { page: 3, text: "The project deadline is the thirtieth of November." },
  ];

  it("cited answer is persisted with no verification note", async () => {
    const docId = await seedDocument(userId, "ready", budgetPages);
    testState.modelText =
      "The quarterly budget is five thousand rupees [p. 1].";
    const res = await POST(
      chatRequest({
        conversationId: null,
        message: userMessage("m1", "what is the budget"),
        documentId: docId,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("five thousand rupees");
    expect(await usageCount(db, userId)).toBe(1);
    expect(testState.modelCalls).toBe(1);

    // The retrieved page text reached the model inside the untrusted block.
    expect(promptText()).toContain("=== UNTRUSTED DATA START ===");
    expect(promptText()).toContain("budget is five thousand rupees");
    expect(promptText()).toContain("[p. 1]");

    const messages = await storedMessages();
    expect(messages).toEqual([
      { role: "user", content: "what is the budget" },
      {
        role: "assistant",
        content: "The quarterly budget is five thousand rupees [p. 1].",
      },
    ]);
  });

  it("unsupported question declined explicitly, no verification note", async () => {
    const docId = await seedDocument(userId, "ready", budgetPages);
    testState.modelText = "The document does not say.";
    const res = await POST(
      chatRequest({
        conversationId: null,
        message: userMessage("m1", "what is the deadline for the report"),
        documentId: docId,
      }),
    );
    expect(res.status).toBe(200);
    await res.text();
    const messages = await storedMessages();
    expect(messages).toEqual([
      { role: "user", content: "what is the deadline for the report" },
      { role: "assistant", content: "The document does not say." },
    ]);
  });

  it("answer with no citation gets a verification note, not a sourced reply", async () => {
    const docId = await seedDocument(userId, "ready", budgetPages);
    testState.modelText = "The quarterly budget is five thousand rupees.";
    const res = await POST(
      chatRequest({
        conversationId: null,
        message: userMessage("m1", "what is the budget"),
        documentId: docId,
      }),
    );
    expect(res.status).toBe(200);
    await res.text();
    const messages = await storedMessages();
    expect(messages).toEqual([
      { role: "user", content: "what is the budget" },
      {
        role: "assistant",
        content: "The quarterly budget is five thousand rupees.",
      },
      {
        role: "system",
        content:
          "Note: this reply's citations could not be verified against the stored document pages.",
      },
    ]);
  });

  it("citation to a page the model never saw gets a verification note", async () => {
    const docId = await seedDocument(userId, "ready", budgetPages);
    testState.modelText = "The deadline is November [p. 3].";
    const res = await POST(
      chatRequest({
        conversationId: null,
        message: userMessage("m1", "what is the budget"),
        documentId: docId,
      }),
    );
    expect(res.status).toBe(200);
    await res.text();
    // The question only retrieved page 1, so [p. 3] is unverifiable.
    expect(promptText()).toContain("[p. 1]");
    expect(promptText()).not.toContain("deadline is the thirtieth");
    const messages = await storedMessages();
    expect(messages).toHaveLength(3);
    expect(messages[2].role).toBe("system");
    expect(messages[2].content).toContain("could not be verified");
  });

  it("unknown document gets 404 and reserves nothing", async () => {
    const res = await POST(
      chatRequest({
        conversationId: null,
        message: userMessage("m1", "what is the budget"),
        documentId: "00000000-0000-4000-8000-000000000000",
      }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("document_not_found");
    expect(await usageCount(db, userId)).toBe(0);
    expect(testState.modelCalls).toBe(0);
  });

  it("document that is not ready gets 400 and reserves nothing", async () => {
    const docId = await seedDocument(userId, "processing", null);
    const res = await POST(
      chatRequest({
        conversationId: null,
        message: userMessage("m1", "what is the budget"),
        documentId: docId,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("document_not_ready");
    expect(await usageCount(db, userId)).toBe(0);
    expect(testState.modelCalls).toBe(0);
  });

  it("another user's document looks absent: 404, reserves nothing", async () => {
    const docId = await seedDocument(otherUserId, "ready", budgetPages);
    const res = await POST(
      chatRequest({
        conversationId: null,
        message: userMessage("m1", "what is the budget"),
        documentId: docId,
      }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("document_not_found");
    expect(await usageCount(db, userId)).toBe(0);
    expect(testState.modelCalls).toBe(0);
  });

  it("retrieval is full-text: only matching pages reach the model", async () => {
    const docId = await seedDocument(userId, "ready", budgetPages);
    const res = await POST(
      chatRequest({
        conversationId: null,
        message: userMessage("m1", "when is the deadline"),
        documentId: docId,
      }),
    );
    expect(res.status).toBe(200);
    await res.text();
    expect(promptText()).toContain("deadline is the thirtieth");
    expect(promptText()).not.toContain("budget is five thousand");
    expect(promptText()).not.toContain("Travel costs are capped");
  });

  it("retrieval is capped at five pages", async () => {
    const sevenPages = Array.from({ length: 7 }, (_, i) => ({
      page: i + 1,
      text: `Report section ${i + 1} about the quarterly report.`,
    }));
    const docId = await seedDocument(userId, "ready", sevenPages);
    const res = await POST(
      chatRequest({
        conversationId: null,
        // A single term: plainto_tsquery ANDs every term, so a natural
        // question ("what does the report say") would also demand 'doe'
        // and 'say', which no page contains. 'report' matches all pages.
        message: userMessage("m1", "report"),
        documentId: docId,
      }),
    );
    expect(res.status).toBe(200);
    await res.text();
    expect(promptText()).toContain("[p. 5]");
    expect(promptText()).not.toContain("[p. 6]");
    expect(promptText()).not.toContain("[p. 7]");
  });
});
