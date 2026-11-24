// Tavily provider adapter tests (M6-2): the adapter sends one basic
// search with the right body and headers, parses results, and throws
// a typed error for a missing key, a provider failure, or a malformed
// response. No live key or network is involved: the fetch is injected.
//
// Recorded honestly: a real round-trip to api.tavily.com is untested
// in this build — there is no live Tavily key here.
import { describe, expect, it, vi } from "vitest";
import { searchTavily, TavilyError } from "@/lib/search/tavily";

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("searchTavily", () => {
  it("sends a basic search with snippets only and parses the results", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        results: [
          {
            title: "Example",
            url: "https://example.com/a",
            content: "A snippet.",
            score: 0.9,
          },
          { title: "Second", url: "https://example.com/b", content: "", score: 0.4 },
        ],
      }),
    );
    const out = await searchTavily("what is vesit", {
      apiKey: "tvly-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toEqual({
      title: "Example",
      url: "https://example.com/a",
      content: "A snippet.",
      score: 0.9,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.tavily.com/search");
    expect(init.method).toBe("POST");
    expect(
      (init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer tvly-test");
    expect(JSON.parse(String(init.body))).toEqual({
      query: "what is vesit",
      search_depth: "basic",
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
    });
  });

  it("throws provider-misconfigured when no key is set", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ results: [] }));
    await expect(
      searchTavily("x", {
        apiKey: "",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: "provider-misconfigured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws provider-error on a non-OK status", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("rate limited", { status: 429 }),
    );
    await expect(
      searchTavily("x", {
        apiKey: "tvly-test",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "provider-error" });
  });

  it("throws provider-error when the fetch itself fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      searchTavily("x", {
        apiKey: "tvly-test",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "provider-error" });
  });

  it("throws provider-error on invalid JSON or a missing results array", async () => {
    const badJson = vi.fn(
      async () => new Response("not json", { status: 200 }),
    );
    await expect(
      searchTavily("x", {
        apiKey: "tvly-test",
        fetchImpl: badJson as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "provider-error" });
    const noResults = vi.fn(async () => okResponse({ answer: "hi" }));
    await expect(
      searchTavily("x", {
        apiKey: "tvly-test",
        fetchImpl: noResults as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "provider-error" });
  });

  it("fills missing fields with defaults instead of crashing", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ results: [{ url: "https://example.com/a" }] }),
    );
    const out = await searchTavily("x", {
      apiKey: "tvly-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.results[0]).toEqual({
      title: "",
      url: "https://example.com/a",
      content: "",
      score: 0,
    });
  });

  it("is a TavilyError with the right name and code", async () => {
    try {
      await searchTavily("x", { apiKey: "" });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TavilyError);
      expect((err as TavilyError).code).toBe("provider-misconfigured");
    }
  });
});
