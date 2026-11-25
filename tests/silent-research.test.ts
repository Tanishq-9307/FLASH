// Silent web research tests (2026-11-24): the trigger heuristic,
// the context block, and the run/record/log orchestration — with a
// fake provider and a fake admin rpc, so no network or key is used.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import {
  buildResearchContextBlock,
  isResearchAvailable,
  runSilentResearch,
  shouldResearch,
} from "@/lib/search/silent-research";
import { TavilyError } from "@/lib/search/tavily";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("shouldResearch — trigger heuristic", () => {
  it.each([
    "What is the latest news about ISRO today?",
    "Latest iPhone price in India",
    "How much does the Acer Nitro V15 cost now?",
    "When is the next SpaceX launch?",
    "What happened in the cricket match today?",
    "Search the web for the Techfest 2026 dates",
    "Look this up online: who won the election?",
    "What is the weather in Mumbai this week?",
    "Is the new Spider-Man game out yet?",
    "What are the current petrol prices in 2026?",
    "Google the release date of GTA 6",
  ])("researches when warranted: %s", (question) => {
    expect(shouldResearch(question)).toBe(true);
  });

  it.each([
    "hello",
    "hi there",
    "thanks!",
    "What is the capital of France?",
    "Explain how a PID controller works",
    "What did I note about the robot arm?",
    "Show me my pending tasks",
    "What is on my schedule tomorrow?",
    "Remember that the meeting is at 4pm",
    "Who are you?",
    "What can you do?",
    "How are you today?",
    "Remind me to buy milk",
    "Write a poem about robots",
  ])("skips when not warranted: %s", (question) => {
    expect(shouldResearch(question)).toBe(false);
  });

  it("never researches a document question, even with recency words", () => {
    expect(
      shouldResearch("What is the latest result in this report?", {
        hasDocument: true,
      }),
    ).toBe(false);
    expect(
      shouldResearch("What is the latest result in this report?", {
        hasDocument: false,
      }),
    ).toBe(true);
  });

  it("skips empty and tiny inputs", () => {
    expect(shouldResearch("")).toBe(false);
    expect(shouldResearch("hi")).toBe(false);
  });
});

describe("isResearchAvailable", () => {
  it("is false with no key and true with a key", () => {
    vi.stubEnv("TAVILY_API_KEY", "");
    expect(isResearchAvailable()).toBe(false);
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    expect(isResearchAvailable()).toBe(true);
  });
});

describe("buildResearchContextBlock", () => {
  it("names the query and wraps results in the untrusted-data block", () => {
    const block = buildResearchContextBlock("latest ISRO news", {
      sources: [{ title: "ISRO launches", url: "https://example.com/a" }],
      content:
        "=== UNTRUSTED DATA START ===\n[1] ISRO launches — example.com\nNews text\n=== UNTRUSTED DATA END ===",
    });
    expect(block).toContain('"latest ISRO news"');
    expect(block).toContain("=== UNTRUSTED DATA START ===");
    expect(block).toContain("ISRO launches");
    expect(block).toContain("News text");
  });
});

type RpcCall = { fn: string; args: Record<string, unknown> };

/** A fake admin client: record_search / refund_search /
 * log_read_only_action with scripted outcomes, every call recorded. */
function fakeAdmin(overrides: Partial<Record<string, (args: RpcCall["args"]) => unknown>> = {}) {
  const calls: RpcCall[] = [];
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    const handler = overrides[fn];
    if (handler) return handler(args);
    if (fn === "record_search") {
      return { data: [{ searches: 1, usage_date: "2026-11-24" }], error: null };
    }
    if (fn === "refund_search") return { data: null, error: null };
    if (fn === "log_read_only_action") {
      return { data: [{ id: "log-1" }], error: null };
    }
    throw new Error(`unexpected rpc ${fn}`);
  });
  const admin = { rpc } as unknown as SupabaseClient<Database>;
  return { admin, calls, rpc };
}

const fakeResults = {
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

const baseDeps = {
  userId: "user-1",
  conversationId: "conv-1",
  query: "latest ISRO news today",
};

describe("runSilentResearch", () => {
  it("records one search, searches, logs success, and returns findings for context", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    const { admin, calls } = fakeAdmin();
    const provider = vi.fn(async () => fakeResults);
    const result = await runSilentResearch({
      ...baseDeps,
      admin,
      searchProvider: provider,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.resultCount).toBe(2);
    expect(result.sources).toEqual([
      { title: "ISRO launches new satellite", url: "https://example.com/isro" },
      { title: "Second report", url: "https://example.com/second" },
    ]);
    expect(result.contextBlock).toContain("ISRO launched a satellite today.");
    expect(result.contextBlock).toContain("=== UNTRUSTED DATA START ===");
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith("latest ISRO news today");
    const recordCalls = calls.filter((c) => c.fn === "record_search");
    expect(recordCalls).toHaveLength(1);
    expect(recordCalls[0].args).toEqual({ p_user_id: "user-1" });
    const logCalls = calls.filter((c) => c.fn === "log_read_only_action");
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0].args.p_tool).toBe("web_search");
    expect(logCalls[0].args.p_status).toBe("succeeded");
    const params = logCalls[0].args.p_params as Record<string, unknown>;
    expect(params.query).toBe("latest ISRO news today");
    expect(params.mode).toBe("silent");
    expect(logCalls[0].args.p_conversation_id).toBe("conv-1");
    const logResult = logCalls[0].args.p_result as Record<string, unknown>;
    expect(logResult.resultCount).toBe(2);
    expect(logCalls[0].args.p_tool_call_id as string).toMatch(/^silent-/);
  });

  it("returns empty (not ok) when the provider answers with no results — and still counts the search", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    const { admin, calls } = fakeAdmin();
    const result = await runSilentResearch({
      ...baseDeps,
      admin,
      searchProvider: async () => ({ results: [] }),
    });
    expect(result.status).toBe("empty");
    expect(calls.filter((c) => c.fn === "record_search")).toHaveLength(1);
    const logCalls = calls.filter((c) => c.fn === "log_read_only_action");
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0].args.p_status).toBe("succeeded");
    expect(
      (logCalls[0].args.p_result as Record<string, unknown>).resultCount,
    ).toBe(0);
  });

  it("is unavailable with no key: no record, no log, no provider call", async () => {
    vi.stubEnv("TAVILY_API_KEY", "");
    const { admin, calls, rpc } = fakeAdmin();
    const provider = vi.fn(async () => fakeResults);
    const result = await runSilentResearch({
      ...baseDeps,
      admin,
      searchProvider: provider,
    });
    expect(result.status).toBe("unavailable");
    expect(rpc).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(provider).not.toHaveBeenCalled();
  });

  it("is unavailable when the record fails, and never calls the provider", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    const { admin, calls } = fakeAdmin({
      record_search: () => ({ data: null, error: { message: "db down" } }),
    });
    const provider = vi.fn(async () => fakeResults);
    const result = await runSilentResearch({
      ...baseDeps,
      admin,
      searchProvider: provider,
    });
    expect(result.status).toBe("unavailable");
    expect(provider).not.toHaveBeenCalled();
    const logCalls = calls.filter((c) => c.fn === "log_read_only_action");
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0].args.p_status).toBe("failed");
  });

  it("fails honestly on a provider error after dispatch: counted, logged failed, never refunded", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    const { admin, calls } = fakeAdmin();
    const result = await runSilentResearch({
      ...baseDeps,
      admin,
      searchProvider: async () => {
        throw new Error("tavily 500");
      },
    });
    expect(result.status).toBe("failed");
    expect(calls.filter((c) => c.fn === "refund_search")).toHaveLength(0);
    const logCalls = calls.filter((c) => c.fn === "log_read_only_action");
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0].args.p_status).toBe("failed");
  });

  it("refunds the record when the key is missing at dispatch time, and is unavailable", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    const { admin, calls } = fakeAdmin();
    const result = await runSilentResearch({
      ...baseDeps,
      admin,
      searchProvider: async () => {
        throw new TavilyError("provider-misconfigured", "no key");
      },
    });
    expect(result.status).toBe("unavailable");
    const refunds = calls.filter((c) => c.fn === "refund_search");
    expect(refunds).toHaveLength(1);
    expect(refunds[0].args).toEqual({
      p_user_id: "user-1",
      p_usage_date: "2026-11-24",
    });
  });

  it("a failing log write never fails the run", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    const { admin } = fakeAdmin({
      log_read_only_action: () => {
        throw new Error("log down");
      },
    });
    const result = await runSilentResearch({
      ...baseDeps,
      admin,
      searchProvider: async () => fakeResults,
    });
    expect(result.status).toBe("ok");
  });

  it("truncates a very long question to the query limit", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    const { admin } = fakeAdmin();
    const provider = vi.fn(async (query: string) => {
      expect(query.startsWith("latest news")).toBe(true);
      return fakeResults;
    });
    const long = `latest news ${"x".repeat(600)}`;
    const result = await runSilentResearch({
      ...baseDeps,
      admin,
      query: long,
      searchProvider: provider,
    });
    expect(result.status).toBe("ok");
    const sent = provider.mock.calls[0][0];
    expect(sent.length).toBeLessThanOrEqual(500);
  });
});
