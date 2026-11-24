// Resume route tests (M3-20): POST /api/chat/resume delivers each
// approval outcome to the model exactly once, honestly.
// The gate itself is NOT faked: the mocked admin client's rpc calls
// run the real expire_stale_approval / mark_outcome_delivered /
// record_api_call / refund_api_call / append_message functions
// against a fresh PGlite database, and the mocked user-scoped client
// runs the route's real reads through `authenticated` with RLS — so
// the once-only claim, the outcome read, and ownership are proven
// against real Postgres, not against the mock. The model is mocked
// so no real quota is used. Approvals are driven into each final
// state through the real approval functions.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  callAs,
  createTestDb,
  createTestUser,
  deleteTestUser,
  kolkataToday,
  setTestUser,
  usageCount,
} from "./db/helpers";

// Hoisted holders: vi.mock factories run before imports, so shared mutable
// state must live in vi.hoisted.
const testState = vi.hoisted(() => ({
  db: null as PGlite | null,
  user: null as { id: string } | null,
  modelCalls: 0,
  prompts: [] as unknown[],
  modelText: "The task is done.",
  throwOnCall: false,
  throw429: false,
  backupCalls: 0,
  backupText: "Done via OpenRouter.",
  recordFails: false,
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => {
    const { callAs: runAs } = await import("./db/helpers");
    // Minimal supabase-js query builder: only the methods the route uses
    // (select/eq/order/single/limit), executed as `authenticated` so RLS
    // applies exactly as it does for a real browser client.
    class MockBuilder {
      private columns = "*";
      private filters: Array<{ col: string; value: unknown }> = [];
      private orderings: Array<{ col: string; ascending: boolean }> = [];
      private singleRow = false;
      private limitN: number | null = null;

      constructor(private table: string) {}

      select(columns: string): this {
        this.columns = columns;
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
          const r = await runAs<Record<string, unknown>>(
            db,
            "authenticated",
            `SELECT ${this.columns} FROM ${this.table}${where}${orderBy}${limitClause}`,
            params,
          );
          const rows = r.rows;
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
        if (testState.recordFails) {
          return { data: null, error: { message: "record failed" } };
        }
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
      if (fn === "expire_stale_approval") {
        const r = await db.query("SELECT * FROM expire_stale_approval($1, $2)", [
          args.p_user_id,
          args.p_approval_id,
        ]);
        return { data: r.rows, error: null };
      }
      if (fn === "mark_outcome_delivered") {
        const r = await db.query("SELECT * FROM mark_outcome_delivered($1, $2)", [
          args.p_user_id,
          args.p_approval_id,
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
    groq: () => {
      testState.modelCalls += 1;
      return new MockLanguageModelV4({
        doStream: async (options) => {
          testState.prompts.push(options.prompt);
          if (testState.throwOnCall) {
            throw new Error("model unavailable");
          }
          if (testState.throw429) {
            const err = new Error("provider 429 rate limited") as Error & {
              statusCode: number;
            };
            err.statusCode = 429;
            throw err;
          }
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

import { POST } from "@/app/api/chat/resume/route";

// OpenRouter backup (failover test): answers with different text so
// the test can tell which provider replied.
vi.mock("@openrouter/ai-sdk-provider", async () => {
  const { MockLanguageModelV4, simulateReadableStream } = await import("ai/test");
  return {
    createOpenRouter: () => () => {
      return new MockLanguageModelV4({
        doStream: async () => {
          testState.backupCalls += 1;
          const chunks: import("@ai-sdk/provider").LanguageModelV4StreamPart[] = [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: testState.backupText },
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

function resumeRequest(approvalId: string): Request {
  return new Request("http://localhost/api/chat/resume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approval_id: approvalId }),
  });
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

describe("POST /api/chat/resume (M3-20)", () => {
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
  });

  afterEach(async () => {
    await deleteTestUser(db, userId);
    testState.user = null;
    testState.modelCalls = 0;
    testState.prompts = [];
    testState.modelText = "The task is done.";
    testState.throwOnCall = false;
    testState.throw429 = false;
    testState.backupCalls = 0;
    testState.backupText = "Done via OpenRouter.";
    testState.recordFails = false;
    delete process.env.DAILY_MODEL_CALL_CAP;
    vi.unstubAllEnvs();
  });

  async function createConversation(): Promise<string> {
    const r = await callAs<{ id: string }>(
      db,
      "authenticated",
      "INSERT INTO conversations (user_id, title) VALUES ($1, 'Test') RETURNING id",
      [userId],
    );
    return r.rows[0].id;
  }

  async function createApproval(
    conversationId: string,
    title: string,
    ttlSeconds = 300,
  ): Promise<string> {
    const r = await db.query<{ approval_id: string }>(
      "SELECT approval_id FROM create_pending_approval($1, $2, 'call_1', 'create_task', $3, $4)",
      [userId, conversationId, JSON.stringify({ title }), ttlSeconds],
    );
    return r.rows[0].approval_id;
  }

  async function approve(approvalId: string): Promise<void> {
    const r = await callAs<{ approval_status: string }>(
      db,
      "authenticated",
      "SELECT approval_status FROM approve_action($1)",
      [approvalId],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].approval_status).toBe("approved");
  }

  async function execute(approvalId: string): Promise<string> {
    const r = await callAs<{ result_code: string }>(
      db,
      "authenticated",
      "SELECT result_code FROM execute_approved_action($1)",
      [approvalId],
    );
    expect(r.rows).toHaveLength(1);
    return r.rows[0].result_code;
  }

  async function driveToConsumed(conversationId: string, title: string): Promise<string> {
    const id = await createApproval(conversationId, title);
    await approve(id);
    expect(await execute(id)).toBe("claimed");
    return id;
  }

  async function driveToRejected(conversationId: string, title: string): Promise<string> {
    const id = await createApproval(conversationId, title);
    const r = await callAs<{ approval_status: string }>(
      db,
      "authenticated",
      "SELECT approval_status FROM reject_action($1)",
      [id],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].approval_status).toBe("rejected");
    return id;
  }

  async function driveToFailed(conversationId: string): Promise<string> {
    // A 300-character title passes create_pending_approval (no server
    // validation here) but fails the tasks CHECK at execution, so the
    // tool write rolls back with tool_error — three recorded failures
    // close the approval as failed.
    const id = await createApproval(conversationId, "x".repeat(300));
    await approve(id);
    expect(await execute(id)).toBe("tool_error");
    for (let i = 0; i < 3; i++) {
      await callAs(
        db,
        "service_role",
        "SELECT record_execution_failure($1, $2, '{\"error\": \"tool_error\"}'::jsonb)",
        [id, userId],
      );
    }
    return id;
  }

  async function driveToTamperFailed(conversationId: string): Promise<string> {
    const id = await createApproval(conversationId, "Buy milk");
    await approve(id);
    // Tamper with the stored parameters: the immutability trigger is
    // disabled only for this test, then re-enabled and verified back on.
    await db.query("ALTER TABLE tool_approvals DISABLE TRIGGER tool_approvals_immutable");
    await db.query(
      "UPDATE tool_approvals SET parameters = '{\"title\": \"Steal the car\"}'::jsonb WHERE id = $1",
      [id],
    );
    await db.query("ALTER TABLE tool_approvals ENABLE TRIGGER tool_approvals_immutable");
    const trigger = await db.query<{ tgenabled: string }>(
      "SELECT tgenabled FROM pg_trigger WHERE tgname = 'tool_approvals_immutable'",
    );
    expect(trigger.rows[0].tgenabled).toBe("O");
    expect(await execute(id)).toBe("hash_mismatch");
    await callAs(
      db,
      "service_role",
      "SELECT record_claim_failure($1, $2, 'hash_mismatch', true)",
      [id, userId],
    );
    return id;
  }

  async function storedMessages(): Promise<Array<{ role: string; content: string }>> {
    return waitFor(async () => {
      const r = await db.query<{ role: string; content: string }>(
        "SELECT role, content FROM messages ORDER BY created_at, id",
      );
      return r.rows.length > 0 ? r.rows : null;
    });
  }

  async function messageCount(): Promise<number> {
    const r = await db.query<{ n: string }>("SELECT count(*) AS n FROM messages");
    return Number(r.rows[0].n);
  }

  it("a not-final approval is a no-op: 200, no model call, nothing persisted", async () => {
    const conversationId = await createConversation();
    const id = await createApproval(conversationId, "Buy milk");
    const res = await POST(resumeRequest(id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "none" });
    expect(testState.modelCalls).toBe(0);
    expect(await usageCount(db, userId)).toBe(0);
    expect(await messageCount()).toBe(0);
    // The outcome was not claimed: outcome_delivered_at is still null.
    const row = await db.query<{ outcome_delivered_at: string | null }>(
      "SELECT outcome_delivered_at FROM tool_approvals WHERE id = $1",
      [id],
    );
    expect(row.rows[0].outcome_delivered_at).toBeNull();
  });

  it("parallel resumes deliver the outcome exactly once", async () => {
    const conversationId = await createConversation();
    const id = await driveToConsumed(conversationId, "Buy milk");
    testState.modelText = "The task is done.";
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => POST(resumeRequest(id))),
    );
    const streams = responses.filter((r) =>
      (r.headers.get("content-type") ?? "").includes("text/event-stream"),
    );
    expect(streams).toHaveLength(1);
    for (const res of streams) await res.text();
    for (const res of responses) {
      if ((res.headers.get("content-type") ?? "").includes("application/json")) {
        expect(await res.json()).toEqual({ outcome: "none" });
      }
    }
    expect(testState.modelCalls).toBe(1);
    expect(await usageCount(db, userId)).toBe(1);
    const messages = await storedMessages();
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(messages.find((m) => m.role === "assistant")?.content).toBe(
      "The task is done.",
    );
  });

  it("a succeeded outcome produces a follow-up built from the database", async () => {
    const conversationId = await createConversation();
    const id = await driveToConsumed(conversationId, "Buy milk");
    testState.modelText = "Done — the task is created.";
    const res = await POST(resumeRequest(id));
    expect(res.status).toBe(200);
    await res.text();
    expect(testState.modelCalls).toBe(1);
    expect(await usageCount(db, userId)).toBe(1);
    // The follow-up prompt carries the database outcome, not a
    // browser-supplied one. The instructions are the first message
    // of the standardised prompt; read them raw (JSON.stringify
    // would escape the quotes around the title).
    const promptMessages = testState.prompts[0] as Array<{ content: string }>;
    expect(promptMessages[0].content).toContain(
      'The task "Buy milk" was created.',
    );
    // The follow-up survives a refresh: it is in the database.
    const messages = await storedMessages();
    expect(messages.map((m) => m.role)).toEqual(["tool", "assistant"]);
    expect(messages[1].content).toBe("Done — the task is created.");
  });

  it("a failed outcome produces a follow-up naming the three failures", async () => {
    const conversationId = await createConversation();
    const id = await driveToFailed(conversationId);
    testState.modelText = "It failed three times, so the approval is closed.";
    const res = await POST(resumeRequest(id));
    expect(res.status).toBe(200);
    await res.text();
    expect(JSON.stringify(testState.prompts[0])).toContain("failed three times");
    const messages = await storedMessages();
    expect(messages.find((m) => m.role === "assistant")?.content).toBe(
      "It failed three times, so the approval is closed.",
    );
  });

  it("a tamper-closed approval produces a follow-up naming the mismatch", async () => {
    const conversationId = await createConversation();
    const id = await driveToTamperFailed(conversationId);
    testState.modelText = "The parameters did not match, so it was closed.";
    const res = await POST(resumeRequest(id));
    expect(res.status).toBe(200);
    await res.text();
    expect(JSON.stringify(testState.prompts[0])).toContain(
      "did not match what was approved",
    );
    const messages = await storedMessages();
    expect(messages.find((m) => m.role === "assistant")?.content).toBe(
      "The parameters did not match, so it was closed.",
    );
  });

  it("a rejected outcome produces a follow-up naming the rejection", async () => {
    const conversationId = await createConversation();
    const id = await driveToRejected(conversationId, "Buy milk");
    testState.modelText = "You rejected it, so nothing was created.";
    const res = await POST(resumeRequest(id));
    expect(res.status).toBe(200);
    await res.text();
    const promptMessages = testState.prompts[0] as Array<{ content: string }>;
    expect(promptMessages[0].content).toContain(
      'The proposed task "Buy milk" was rejected',
    );
    const messages = await storedMessages();
    expect(messages.find((m) => m.role === "assistant")?.content).toBe(
      "You rejected it, so nothing was created.",
    );
  });

  it("an expired outcome produces a follow-up naming the expiry", async () => {
    const conversationId = await createConversation();
    const id = await createApproval(conversationId, "Buy milk", 1);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    testState.modelText = "It expired before you decided.";
    const res = await POST(resumeRequest(id));
    expect(res.status).toBe(200);
    await res.text();
    expect(JSON.stringify(testState.prompts[0])).toContain(
      "expired before it was decided",
    );
    const messages = await storedMessages();
    expect(messages.find((m) => m.role === "assistant")?.content).toBe(
      "It expired before you decided.",
    );
  });

  it("a record failure returns the real outcome with a system notice and no model reply", async () => {
    // The record is forced to fail through the mock flag: the route
    // fails closed (no uncounted call) and still delivers the outcome
    // as a persisted system notice.
    const today = await kolkataToday(db);
    await db.query(
      "INSERT INTO api_usage (user_id, usage_date, model_calls) VALUES ($1, $2, 1)",
      [userId, today],
    );
    testState.recordFails = true;
    const conversationId = await createConversation();
    const id = await driveToConsumed(conversationId, "Buy milk");
    const res = await POST(resumeRequest(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe("succeeded");
    expect(body.notice).toContain('The task "Buy milk" was created.');
    expect(body.notice).toContain("could not be recorded");
    expect(testState.modelCalls).toBe(0);
    expect(await usageCount(db, userId)).toBe(1);
    // The notice survives a refresh: it is in the database as a
    // system message.
    const messages = await storedMessages();
    expect(messages.map((m) => m.role)).toEqual(["tool", "system"]);
    expect(messages[1].content).toBe(body.notice);
  });

  it("a model failure returns the real outcome with a system notice", async () => {
    // The mock throws inside doStream, so the failure surfaces
    // lazily in the stream (the route's try/catch around streamText
    // only catches a throw before dispatch). The stream ends in
    // error; the outcome is delivered as a persisted system notice.
    // The call was dispatched, so per the chat route's rule a
    // provider error after dispatch is NOT refunded: usage stays 1.
    testState.throwOnCall = true;
    const conversationId = await createConversation();
    const id = await driveToConsumed(conversationId, "Buy milk");
    const res = await POST(resumeRequest(id));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const streamText = await res.text();
    // The stream ends in error (the onError fallback is the stream's
    // error text); the outcome itself is delivered by the persisted
    // system notice below.
    expect(streamText).toContain('"type":"error"');
    expect(testState.modelCalls).toBe(1);
    expect(await usageCount(db, userId)).toBe(1);
    const messages = await storedMessages();
    expect(messages.map((m) => m.role)).toEqual(["tool", "system"]);
    expect(messages[1].content).toContain('The task "Buy milk" was created.');
    expect(messages[1].content).toContain("model reply failed");
  });

  it("primary 429 fails over to the OpenRouter backup for the follow-up", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    testState.throw429 = true;
    const conversationId = await createConversation();
    const id = await driveToConsumed(conversationId, "Buy milk");
    const res = await POST(resumeRequest(id));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Done via OpenRouter.");
    expect(body).not.toContain('"type":"error"');
    expect(testState.modelCalls).toBe(1);
    expect(testState.backupCalls).toBe(1);
    expect(await usageCount(db, userId)).toBe(1);
    const messages = await storedMessages();
    expect(messages.map((m) => m.role)).toEqual(["tool", "assistant"]);
    expect(messages[1].content).toBe("Done via OpenRouter.");
  });
});
