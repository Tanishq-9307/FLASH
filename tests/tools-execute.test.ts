// executeToolCall tests (M3-17, M3-18): one model tool call, executed
// server-side — invalid arguments and unknown tools get an error
// result with nothing running; state-changing tools are recorded as
// proposals with create_pending_approval (never executed) and return
// approval_created, or a discarded error result when an approval is
// already open; read-only success and failure both log correctly.
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { TavilyError } from "@/lib/search/tavily";
import { executeToolCall } from "@/lib/tools/execute-tool-call";

// Fake user-scoped client: the tasks query returns canned rows, or
// throws when told to, through a thenable query chain.
function fakeUserClient(opts: {
  tasks?: Array<{ id: string; title: string; due_date: string | null; status: string }>;
  throwOnQuery?: Error;
}): SupabaseClient<Database> {
  class FakeBuilder {
    select() {
      return this;
    }
    eq() {
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    then(resolve: (v: unknown) => void, reject: (e: unknown) => void): unknown {
      if (opts.throwOnQuery) {
        return Promise.reject(opts.throwOnQuery).then(resolve, reject);
      }
      return Promise.resolve({ data: opts.tasks ?? [], error: null }).then(
        resolve,
        reject,
      );
    }
  }
  return {
    from: () => new FakeBuilder(),
  } as unknown as SupabaseClient<Database>;
}

function fakeAdminClient(opts?: {
  /** What create_pending_approval returns (default: created). */
  approvalResult?: { result_code: string; approval_id: string | null; log_id: string | null };
  /** If set, create_pending_approval errors with this message. */
  approvalError?: string;
  /** What reserve_search returns (default: one reserved row). Set to
   * [] to simulate a hit cap, or reserveSearchError to simulate a
   * database failure. */
  reserveSearchRows?: Array<{ searches: number; usage_date: string }>;
  /** If set, reserve_search errors with this message. */
  reserveSearchError?: string;
}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === "create_pending_approval") {
        if (opts?.approvalError !== undefined) {
          return { data: null, error: { message: opts.approvalError } };
        }
        return {
          data: [
            opts?.approvalResult ?? {
              result_code: "created",
              approval_id: "00000000-0000-0000-0000-000000000042",
              log_id: "00000000-0000-0000-0000-000000000043",
            },
          ],
          error: null,
        };
      }
      if (fn === "reserve_search") {
        if (opts?.reserveSearchError !== undefined) {
          return { data: null, error: { message: opts.reserveSearchError } };
        }
        return {
          data: opts?.reserveSearchRows ?? [
            { searches: 1, usage_date: "2026-11-24" },
          ],
          error: null,
        };
      }
      if (fn === "refund_search") {
        return { data: null, error: null };
      }
      return { data: [{ id: "00000000-0000-0000-0000-000000000099" }], error: null };
    }),
  } as unknown as SupabaseClient<Database>;
  return { client, rpcCalls };
}

const USER = "00000000-0000-0000-0000-000000000001";
const CONV = "00000000-0000-0000-0000-000000000002";
const CALL = { toolCallId: "call_1", toolName: "get_tasks", input: {} };

describe("executeToolCall (M3-17, M3-18)", () => {
  it("runs get_tasks and logs the success with the result", async () => {
    const { client, rpcCalls } = fakeAdminClient();
    const tasks = [
      { id: "t1", title: "Buy milk", due_date: null, status: "pending" },
      { id: "t2", title: "Call the bank", due_date: "2026-12-01T00:00:00Z", status: "pending" },
    ];
    const executed = await executeToolCall(
      { supabase: fakeUserClient({ tasks }), admin: client },
      USER,
      CONV,
      CALL,
    );
    expect(executed.outcome).toBe("tool_result");
    if (executed.outcome !== "tool_result") throw new Error("expected tool_result");
    const { result, summary } = executed;
    expect(result.type).toBe("tool-result");
    expect(result.toolCallId).toBe("call_1");
    if (result.type === "tool-result" && result.output.type === "json") {
      expect(result.output.value).toEqual({ tasks });
    } else {
      throw new Error("expected a json tool result");
    }
    expect(summary).toContain("Returned 2 task(s)");
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("log_read_only_action");
    expect(rpcCalls[0].args).toMatchObject({
      p_user_id: USER,
      p_conversation_id: CONV,
      p_tool_call_id: "call_1",
      p_tool: "get_tasks",
      p_status: "succeeded",
    });
    expect(rpcCalls[0].args.p_result).toEqual({ tasks });
  });

  it("passes the validated status filter to the query", async () => {
    const { client, rpcCalls } = fakeAdminClient();
    const executed = await executeToolCall(
      { supabase: fakeUserClient({ tasks: [] }), admin: client },
      USER,
      CONV,
      { toolCallId: "call_1", toolName: "get_tasks", input: { status: "completed" } },
    );
    expect(executed.outcome).toBe("tool_result");
    if (executed.outcome !== "tool_result") throw new Error("expected tool_result");
    expect(executed.result.type).toBe("tool-result");
    expect(rpcCalls[0].args.p_params).toEqual({ status: "completed" });
  });

  it("logs the failure and returns an honest error result when the query throws", async () => {
    const { client, rpcCalls } = fakeAdminClient();
    const executed = await executeToolCall(
      {
        supabase: fakeUserClient({
          throwOnQuery: new Error("relation \"tasks\" does not exist"),
        }),
        admin: client,
      },
      USER,
      CONV,
      CALL,
    );
    expect(executed.outcome).toBe("tool_result");
    if (executed.outcome !== "tool_result") throw new Error("expected tool_result");
    const { result, summary } = executed;
    expect(result.type).toBe("tool-result");
    if (result.type === "tool-result") {
      expect(result.output.type).toBe("error-json");
      if (result.output.type === "error-json") {
        expect(result.output.value).toEqual({ error: "query_failed" });
      }
    }
    // No database internals leak into the result.
    expect(JSON.stringify(result)).not.toContain("does not exist");
    expect(summary).toContain("could not be loaded");
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].args).toMatchObject({
      p_tool: "get_tasks",
      p_status: "failed",
    });
    expect(rpcCalls[0].args.p_result).toEqual({ error: "query_failed" });
  });

  it("returns an invalid-arguments error result and runs nothing", async () => {
    const { client, rpcCalls } = fakeAdminClient();
    const executed = await executeToolCall(
      { supabase: fakeUserClient({ tasks: [] }), admin: client },
      USER,
      CONV,
      { toolCallId: "call_1", toolName: "get_tasks", input: { status: "done" } },
    );
    expect(executed.outcome).toBe("tool_result");
    if (executed.outcome !== "tool_result") throw new Error("expected tool_result");
    const { result, summary } = executed;
    expect(result.type).toBe("tool-result");
    if (result.type === "tool-result" && result.output.type === "error-json") {
      expect(result.output.value).toMatchObject({ error: "invalid_arguments" });
    } else {
      throw new Error("expected an invalid_arguments error result");
    }
    expect(summary).toContain("invalid arguments");
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejects an unknown tool name and runs nothing", async () => {
    const { client, rpcCalls } = fakeAdminClient();
    const executed = await executeToolCall(
      { supabase: fakeUserClient({ tasks: [] }), admin: client },
      USER,
      CONV,
      { toolCallId: "call_1", toolName: "delete_task", input: { title: "x" } },
    );
    expect(executed.outcome).toBe("tool_result");
    if (executed.outcome !== "tool_result") throw new Error("expected tool_result");
    const { result } = executed;
    if (result.type === "tool-result" && result.output.type === "error-json") {
      expect(result.output.value).toEqual({ error: "unknown_tool" });
    } else {
      throw new Error("expected an unknown_tool error result");
    }
    expect(rpcCalls).toHaveLength(0);
  });

  it("records a create_task proposal and returns approval_created, executing nothing", async () => {
    const { client, rpcCalls } = fakeAdminClient();
    const executed = await executeToolCall(
      { supabase: fakeUserClient({ tasks: [] }), admin: client },
      USER,
      CONV,
      {
        toolCallId: "call_1",
        toolName: "create_task",
        input: { title: "Buy milk", due_date: "2026-12-01T00:00:00Z" },
      },
    );
    expect(executed.outcome).toBe("approval_created");
    if (executed.outcome !== "approval_created") throw new Error("expected approval_created");
    expect(executed.approvalId).toBe("00000000-0000-0000-0000-000000000042");
    expect(executed.summary).toContain('Proposed creating task "Buy milk"');
    expect(executed.summary).toContain("Waiting for your approval");
    // Exactly one rpc: the proposal. No task was created (the user
    // client was never touched) and no log_read_only_action ran.
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("create_pending_approval");
    expect(rpcCalls[0].args).toMatchObject({
      p_user_id: USER,
      p_conversation_id: CONV,
      p_tool_call_id: "call_1",
      p_tool: "create_task",
      p_params: { title: "Buy milk", due_date: "2026-12-01T00:00:00Z" },
      p_ttl_seconds: 300,
    });
  });

  it("records a save_memory proposal and returns approval_created", async () => {
    const { client, rpcCalls } = fakeAdminClient();
    const executed = await executeToolCall(
      { supabase: fakeUserClient({ tasks: [] }), admin: client },
      USER,
      CONV,
      {
        toolCallId: "call_1",
        toolName: "save_memory",
        input: { fact: "My favourite colour is blue." },
      },
    );
    expect(executed.outcome).toBe("approval_created");
    if (executed.outcome !== "approval_created") throw new Error("expected approval_created");
    expect(executed.summary).toContain("Proposed saving a memory");
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].args).toMatchObject({
      p_tool: "save_memory",
      p_params: { fact: "My favourite colour is blue." },
    });
  });

  it("discards the proposal when an approval is already open", async () => {
    const { client, rpcCalls } = fakeAdminClient({
      approvalResult: {
        result_code: "open_approval_exists",
        approval_id: null,
        log_id: null,
      },
    });
    const executed = await executeToolCall(
      { supabase: fakeUserClient({ tasks: [] }), admin: client },
      USER,
      CONV,
      {
        toolCallId: "call_1",
        toolName: "create_task",
        input: { title: "Buy milk" },
      },
    );
    expect(executed.outcome).toBe("tool_result");
    if (executed.outcome !== "tool_result") throw new Error("expected tool_result");
    const { result, summary } = executed;
    if (result.type === "tool-result" && result.output.type === "error-json") {
      expect(result.output.value).toMatchObject({ error: "open_approval_exists" });
    } else {
      throw new Error("expected an open_approval_exists error result");
    }
    expect(summary).toContain("already open");
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("create_pending_approval");
  });

  it("returns proposal_failed when the proposal cannot be recorded", async () => {
    const { client, rpcCalls } = fakeAdminClient({
      approvalError: "permission denied for function create_pending_approval",
    });
    const executed = await executeToolCall(
      { supabase: fakeUserClient({ tasks: [] }), admin: client },
      USER,
      CONV,
      {
        toolCallId: "call_1",
        toolName: "create_task",
        input: { title: "Buy milk" },
      },
    );
    expect(executed.outcome).toBe("tool_result");
    if (executed.outcome !== "tool_result") throw new Error("expected tool_result");
    const { result } = executed;
    if (result.type === "tool-result" && result.output.type === "error-json") {
      expect(result.output.value).toEqual({ error: "proposal_failed" });
    } else {
      throw new Error("expected a proposal_failed error result");
    }
    // No database internals leak into the result.
    expect(JSON.stringify(result)).not.toContain("permission denied");
    expect(rpcCalls).toHaveLength(1);
  });
});

describe("executeToolCall web_search (M6-2)", () => {
  const SEARCH_CALL = {
    toolCallId: "call_9",
    toolName: "web_search",
    input: { query: "weather in Mumbai" },
  };

  const RESULTS = [
    {
      title: "Mumbai weather",
      url: "https://example.com/weather",
      content: "Sunny, 31°C.",
      score: 0.9,
    },
    {
      title: "Second source",
      url: "https://other.example.org/page",
      content: "Rain expected tonight.",
      score: 0.5,
    },
  ];

  function expectErrorResult(
    executed: Awaited<ReturnType<typeof executeToolCall>>,
    error: string,
  ) {
    expect(executed.outcome).toBe("tool_result");
    if (executed.outcome !== "tool_result") throw new Error("expected tool_result");
    const { result } = executed;
    if (result.type === "tool-result" && result.output.type === "error-json") {
      expect(result.output.value).toMatchObject({ error });
    } else {
      throw new Error(`expected an ${error} error result`);
    }
  }

  it("reserves, calls the provider, logs success, and returns delimited results", async () => {
    const { client, rpcCalls } = fakeAdminClient();
    const provider = vi.fn(async () => ({ results: RESULTS }));
    const executed = await executeToolCall(
      { supabase: fakeUserClient({ tasks: [] }), admin: client },
      USER,
      CONV,
      SEARCH_CALL,
      { searchProvider: provider },
    );
    expect(executed.outcome).toBe("tool_result");
    if (executed.outcome !== "tool_result") throw new Error("expected tool_result");
    const { result, summary } = executed;
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith("weather in Mumbai");
    expect(summary).toContain("2 result(s)");
    if (result.type === "tool-result" && result.output.type === "json") {
      const value = result.output.value as {
        sources: Array<{ title: string; url: string }>;
        content: string;
      };
      expect(value.sources).toEqual([
        { title: "Mumbai weather", url: "https://example.com/weather" },
        { title: "Second source", url: "https://other.example.org/page" },
      ]);
      expect(value.content).toContain("=== UNTRUSTED DATA START ===");
      expect(value.content).toContain("=== UNTRUSTED DATA END ===");
      expect(value.content).toContain("[1] Mumbai weather — example.com");
      expect(value.content).toContain("Sunny, 31°C.");
      expect(value.content).toContain("[2] Second source — other.example.org");
    } else {
      throw new Error("expected a json tool result");
    }
    // Reserve first, then the log — and the reserve used the default cap.
    expect(rpcCalls.map((c) => c.fn)).toEqual([
      "reserve_search",
      "log_read_only_action",
    ]);
    expect(rpcCalls[0].args).toMatchObject({
      p_user_id: USER,
      p_cap: 10,
    });
    expect(rpcCalls[1].args).toMatchObject({
      p_tool: "web_search",
      p_status: "succeeded",
    });
  });

  it("refuses at the cap without calling the provider or logging", async () => {
    const { client, rpcCalls } = fakeAdminClient({ reserveSearchRows: [] });
    const provider = vi.fn(async () => ({ results: RESULTS }));
    const executed = await executeToolCall(
      { supabase: fakeUserClient({ tasks: [] }), admin: client },
      USER,
      CONV,
      SEARCH_CALL,
      { searchProvider: provider },
    );
    expectErrorResult(executed, "search_cap_reached");
    expect(provider).not.toHaveBeenCalled();
    expect(rpcCalls.map((c) => c.fn)).toEqual(["reserve_search"]);
  });

  it("reports a provider failure honestly, logs it, and does NOT refund", async () => {
    const { client, rpcCalls } = fakeAdminClient();
    const provider = vi.fn(async () => {
      throw new TavilyError("provider-error", "Tavily returned HTTP 429.");
    });
    const executed = await executeToolCall(
      { supabase: fakeUserClient({ tasks: [] }), admin: client },
      USER,
      CONV,
      SEARCH_CALL,
      { searchProvider: provider },
    );
    expectErrorResult(executed, "search_unavailable");
    // The dispatch happened, so the reservation stands — no refund.
    expect(rpcCalls.map((c) => c.fn)).toEqual([
      "reserve_search",
      "log_read_only_action",
    ]);
    expect(rpcCalls[1].args).toMatchObject({
      p_tool: "web_search",
      p_status: "failed",
      p_result: { error: "search_unavailable" },
    });
    expect(JSON.stringify(executed)).not.toContain("429");
  });

  it("refunds the reservation on a pre-dispatch abort (missing key)", async () => {
    const { client, rpcCalls } = fakeAdminClient();
    const provider = vi.fn(async () => {
      throw new TavilyError(
        "provider-misconfigured",
        "TAVILY_API_KEY is not set.",
      );
    });
    const executed = await executeToolCall(
      { supabase: fakeUserClient({ tasks: [] }), admin: client },
      USER,
      CONV,
      SEARCH_CALL,
      { searchProvider: provider },
    );
    expectErrorResult(executed, "search_unavailable");
    expect(rpcCalls.map((c) => c.fn)).toEqual([
      "reserve_search",
      "refund_search",
      "log_read_only_action",
    ]);
    expect(rpcCalls[1].args).toMatchObject({
      p_user_id: USER,
      p_usage_date: "2026-11-24",
    });
  });

  it("reports a reservation failure honestly without calling the provider", async () => {
    const { client, rpcCalls } = fakeAdminClient({
      reserveSearchError: "database unavailable",
    });
    const provider = vi.fn(async () => ({ results: RESULTS }));
    const executed = await executeToolCall(
      { supabase: fakeUserClient({ tasks: [] }), admin: client },
      USER,
      CONV,
      SEARCH_CALL,
      { searchProvider: provider },
    );
    expectErrorResult(executed, "search_unavailable");
    expect(provider).not.toHaveBeenCalled();
    expect(rpcCalls.map((c) => c.fn)).toEqual([
      "reserve_search",
      "log_read_only_action",
    ]);
    expect(rpcCalls[1].args).toMatchObject({ p_status: "failed" });
    expect(JSON.stringify(executed)).not.toContain("database unavailable");
  });

  it("treats an empty result list as a valid outcome, not an error", async () => {
    const { client, rpcCalls } = fakeAdminClient();
    const provider = vi.fn(async () => ({ results: [] }));
    const executed = await executeToolCall(
      { supabase: fakeUserClient({ tasks: [] }), admin: client },
      USER,
      CONV,
      SEARCH_CALL,
      { searchProvider: provider },
    );
    expect(executed.outcome).toBe("tool_result");
    if (executed.outcome !== "tool_result") throw new Error("expected tool_result");
    const { result } = executed;
    if (result.type === "tool-result" && result.output.type === "json") {
      const value = result.output.value as { sources: unknown[]; content: string };
      expect(value.sources).toEqual([]);
      expect(value.content).toContain("No results found.");
    } else {
      throw new Error("expected a json tool result");
    }
    expect(rpcCalls[1].args).toMatchObject({ p_status: "succeeded" });
  });
});
