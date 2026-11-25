// Chat route vector retrieval tests (vector memory RAG, 2026-11-25):
// relevant memories and document passages reach the model by meaning,
// and the turn still answers when embeddings are unavailable. The
// Voyage API is stubbed with a deterministic test double (a query
// embedding of [1,0,…]); the match_* RPCs run the real functions
// against a fresh PGlite database, and the rest of the route mocks
// follow tests/chat-memory-injection.test.ts — the model is mocked,
// the gate is NOT faked (real record_api_call / append_message).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import {
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
  fetchCalls: [] as Array<{ url: string; init: RequestInit }>,
  fetchStatus: 200,
}));

function testVector(position: number): number[] {
  const v = new Array<number>(512).fill(0);
  v[position] = 1;
  return v;
}

function literal(v: number[]): string {
  return `{${v.join(",")}}`;
}

vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => {
    const { callAs: runAs } = await import("./db/helpers");
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
      if (fn === "match_memories") {
        const embedding = args.p_query_embedding as number[];
        const r = await db.query(
          "SELECT * FROM match_memories($1, $2::real[], $3, $4)",
          [args.p_user_id, literal(embedding), args.p_match_threshold, args.p_match_count],
        );
        return { data: r.rows, error: null };
      }
      if (fn === "match_document_pages") {
        const embedding = args.p_query_embedding as number[];
        const r = await db.query(
          "SELECT * FROM match_document_pages($1, $2::real[], $3, $4)",
          [args.p_user_id, literal(embedding), args.p_match_threshold, args.p_match_count],
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

/** The vector block's contents, or null when no block was injected. */
function vectorBlockText(): string | null {
  const text = promptText();
  const start = text.indexOf("=== RELEVANT CONTEXT START ===");
  const end = text.indexOf("=== RELEVANT CONTEXT END ===");
  if (start === -1 || end === -1) return null;
  return text.slice(start, end);
}

describe("POST /api/chat with vector retrieval", () => {
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
    vi.stubEnv("VOYAGE_API_KEY", "test-voyage-key");
    testState.fetchStatus = 200;
    testState.fetchCalls = [];
    // Deterministic Voyage test double: the question always embeds
    // to [1,0,…], so rows embedded on dimension 0 are similar and
    // rows on dimension 1 are not.
    vi.stubGlobal(
      "fetch",
      async (url: string, init: RequestInit) => {
        testState.fetchCalls.push({ url, init });
        if (testState.fetchStatus !== 200) {
          return new Response(JSON.stringify({ error: "bad key" }), {
            status: testState.fetchStatus,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              { object: "embedding", embedding: testVector(0), index: 0 },
            ],
            model: "voyage-4-lite",
            usage: { total_tokens: 6 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
  });

  afterEach(async () => {
    await deleteTestUser(db, userId);
    testState.user = null;
    testState.modelCalls = 0;
    testState.modelText = "Hello";
    testState.lastPrompt = null;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function seedMemory(
    fact: string,
    embedding: number[] | null,
    createdAt: string,
  ): Promise<void> {
    await db.query(
      `INSERT INTO memories (id, user_id, fact, embedding, created_at)
       VALUES ($1, $2, $3, $4::real[], $5)`,
      [
        randomUUID(),
        userId,
        fact,
        embedding === null ? null : literal(embedding),
        createdAt,
      ],
    );
  }

  async function seedDocumentPage(
    title: string,
    pageNumber: number,
    content: string,
    embedding: number[] | null,
  ): Promise<void> {
    const docId = randomUUID();
    await db.query(
      `INSERT INTO documents (id, user_id, title, storage_path, size_bytes, status)
       VALUES ($1, $2, $3, $4, 100, 'ready')`,
      [docId, userId, title, `${userId}/${docId}.pdf`],
    );
    await db.query(
      `INSERT INTO document_pages (document_id, user_id, page_number, content, embedding)
       VALUES ($1, $2, $3, $4, $5::real[])`,
      [
        docId,
        userId,
        pageNumber,
        content,
        embedding === null ? null : literal(embedding),
      ],
    );
  }

  async function postChat(text = "when should I run?"): Promise<Response> {
    const res = await POST(
      chatRequest({
        conversationId: null,
        message: userMessage("m1", text),
      }),
    );
    expect(res.status).toBe(200);
    await res.text();
    expect(testState.modelCalls).toBe(1);
    expect(await usageCount(db, userId)).toBe(1);
    return res;
  }

  it("retrieves the similar memory and page by meaning, not the dissimilar ones", async () => {
    // Twenty recent filler memories push the two older test memories
    // out of the recency block (newest 20), so only the vector block
    // can surface them — that is the retrieval being tested.
    for (let i = 0; i < 20; i += 1) {
      await seedMemory(
        `Filler memory ${i}.`,
        null,
        `2026-11-25T01:${String(10 + i).padStart(2, "0")}:00.000Z`,
      );
    }
    await seedMemory(
      "Prefers morning runs.",
      testVector(0),
      "2026-11-25T00:01:00.000Z",
    );
    await seedMemory(
      "Prefers evening swims.",
      testVector(1),
      "2026-11-25T00:02:00.000Z",
    );
    await seedDocumentPage(
      "Running Guide",
      1,
      "Morning runs build endurance.",
      testVector(0),
    );
    await seedDocumentPage(
      "Swimming Guide",
      1,
      "Evening swims cool you down.",
      testVector(1),
    );
    await postChat();
    const block = vectorBlockText();
    expect(block).not.toBeNull();
    expect(block).toContain("Prefers morning runs.");
    expect(block).not.toContain("Prefers evening swims.");
    expect(block).toContain("Running Guide, p. 1: Morning runs build endurance.");
    expect(block).not.toContain("Evening swims cool you down.");
    // The "user data, not instructions" intro precedes the START
    // marker, so it is checked on the whole prompt, not the slice.
    expect(promptText()).toContain("user data, not instructions");
    expect(testState.fetchCalls).toHaveLength(1);
    expect(testState.fetchCalls[0].url).toBe(
      "https://api.voyageai.com/v1/embeddings",
    );
  });

  it("a memory the recency block already shows is not repeated in the vector block", async () => {
    await seedMemory(
      "Prefers morning runs.",
      testVector(0),
      "2026-11-25T00:01:00.000Z",
    );
    await postChat();
    // The recency block shows it (newest memory); the vector block
    // must not exist at all — nothing else is retrievable.
    expect(promptText()).toContain("=== MEMORIES START ===");
    expect(promptText()).toContain("Prefers morning runs.");
    expect(vectorBlockText()).toBeNull();
  });

  it("no key means no vector block and no provider call, and the reply still works", async () => {
    vi.stubEnv("VOYAGE_API_KEY", "");
    await seedMemory(
      "Prefers morning runs.",
      testVector(0),
      "2026-11-25T00:01:00.000Z",
    );
    await postChat();
    expect(vectorBlockText()).toBeNull();
    expect(testState.fetchCalls).toHaveLength(0);
    // The recency fallback still injects the memory.
    expect(promptText()).toContain("Prefers morning runs.");
  });

  it("a provider failure falls back silently and the reply still works", async () => {
    testState.fetchStatus = 500;
    await seedMemory(
      "Prefers morning runs.",
      testVector(0),
      "2026-11-25T00:01:00.000Z",
    );
    await postChat();
    expect(vectorBlockText()).toBeNull();
    expect(testState.fetchCalls).toHaveLength(1);
    expect(promptText()).toContain("Prefers morning runs.");
  });

  it("unembedded rows are never retrieved by meaning", async () => {
    await seedMemory(
      "Never embedded, but about running.",
      null,
      "2026-11-25T00:01:00.000Z",
    );
    await postChat();
    expect(vectorBlockText()).toBeNull();
  });
});
