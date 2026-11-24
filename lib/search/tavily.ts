// Tavily web-search provider adapter (M6-2, TECH_STACK.md §3.4).
//
// Plain language: this is the only place that talks to Tavily. It
// sends one basic search (1 credit) and returns the results as plain
// data — title, URL, snippet, score. It never decides what a result
// means: the results are untrusted web text, and the tool loop
// (lib/tools/read-only.ts) wraps them in a delimited block before the
// model ever sees them.
//
// Server-only: the key is read from the server environment
// (TAVILY_API_KEY, never NEXT_PUBLIC_) at call time, so it never
// reaches the browser. There is no live key in this build, so a real
// round-trip is untested — the tests inject a fake fetch.
//
// Errors are typed, never leaked raw: a missing key is a
// pre-dispatch abort (the caller refunds the record), while a
// provider failure after dispatch is not refunded (the model-call
// record follows the same rule — a dispatched call counts even if the
// provider fails).
export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface TavilySearchResponse {
  results: TavilySearchResult[];
}

export type TavilyErrorCode = "provider-misconfigured" | "provider-error";

export class TavilyError extends Error {
  readonly code: TavilyErrorCode;

  constructor(code: TavilyErrorCode, message: string) {
    super(message);
    this.name = "TavilyError";
    this.code = code;
  }
}

/** A search provider: query in, parsed results out. `searchTavily`
 * below is the real one; tests inject a fake. */
export type SearchProvider = (query: string) => Promise<TavilySearchResponse>;

/** One Tavily basic search. `apiKey` and `fetchImpl` are injectable
 * so tests can run without a key or a network; in production both
 * default to the server environment and the global fetch. */
export async function searchTavily(
  query: string,
  opts: { apiKey?: string; fetchImpl?: typeof fetch } = {},
): Promise<TavilySearchResponse> {
  const apiKey = opts.apiKey ?? process.env.TAVILY_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new TavilyError(
      "provider-misconfigured",
      "TAVILY_API_KEY is not set.",
    );
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: 5,
        include_answer: false,
        include_raw_content: false,
      }),
    });
  } catch (err) {
    throw new TavilyError(
      "provider-error",
      `Tavily request failed: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }
  if (!response.ok) {
    throw new TavilyError(
      "provider-error",
      `Tavily returned HTTP ${response.status}.`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new TavilyError("provider-error", "Tavily returned invalid JSON.");
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { results?: unknown }).results)
  ) {
    throw new TavilyError(
      "provider-error",
      "Tavily returned an unexpected response shape.",
    );
  }
  const results: TavilySearchResult[] = (
    body as { results: Array<Record<string, unknown>> }
  ).results.map((item) => ({
    title: typeof item.title === "string" ? item.title : "",
    url: typeof item.url === "string" ? item.url : "",
    content:
      typeof item.content === "string"
        ? item.content.slice(0, 2000)
        : "",
    score: typeof item.score === "number" ? item.score : 0,
  }));
  return { results };
}
