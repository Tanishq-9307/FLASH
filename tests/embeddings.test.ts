// Embeddings provider client tests (vector memory RAG, 2026-11-25).
// The Voyage API is faked with deterministic test doubles — clearly
// mocked vectors, never presented as real embeddings. No network and
// no key.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDINGS_API_URL,
  EmbeddingsError,
  embedDocuments,
  embedQuery,
  embedTexts,
  isEmbeddingsAvailable,
} from "@/lib/ai/embeddings";

/** A deterministic 512-dim test double: 1 at `position`, 0 elsewhere. */
function testVector(position: number): number[] {
  const v = new Array<number>(512).fill(0);
  v[position] = 1;
  return v;
}

/** A fake Voyage response for the given vectors (total_tokens fixed). */
function voyageResponse(vectors: number[][]): Record<string, unknown> {
  return {
    object: "list",
    data: vectors.map((embedding, i) => ({
      object: "embedding",
      embedding,
      index: i,
    })),
    model: EMBEDDING_MODEL,
    usage: { total_tokens: 7 },
  };
}

function fakeFetch(
  body: Record<string, unknown>,
  status = 200,
): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("embeddings client (Voyage voyage-4-lite)", () => {

  beforeEach(() => {
    vi.stubEnv("VOYAGE_API_KEY", "test-voyage-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("isEmbeddingsAvailable follows the key", () => {
    expect(isEmbeddingsAvailable()).toBe(true);
    vi.stubEnv("VOYAGE_API_KEY", "   ");
    expect(isEmbeddingsAvailable()).toBe(false);
    vi.stubEnv("VOYAGE_API_KEY", "");
    expect(isEmbeddingsAvailable()).toBe(false);
  });

  it("sends the Voyage request shape: model, input_type, output_dimension 512", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(
        JSON.stringify(voyageResponse([testVector(0), testVector(1)])),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const result = await embedTexts(["first fact", "second fact"], {
      inputType: "document",
      fetchImpl,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(EMBEDDINGS_API_URL);
    expect(seen[0].init.method).toBe("POST");
    expect(
      (seen[0].init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer test-voyage-key");
    const body = JSON.parse(String(seen[0].init.body)) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      input: ["first fact", "second fact"],
      model: EMBEDDING_MODEL,
      input_type: "document",
      output_dimension: 512,
      truncation: true,
    });
    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(result.embeddings[0][0]).toBe(1);
    expect(result.usage.totalTokens).toBe(7);
  });

  it("embedQuery uses input_type query and embedDocuments uses document", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify(voyageResponse([testVector(0)])),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    await embedQuery("what do I like", { fetchImpl });
    await embedDocuments(["a stored fact"], { fetchImpl });
    expect(bodies[0].input_type).toBe("query");
    expect(bodies[1].input_type).toBe("document");
  });

  it("a missing key is provider-misconfigured and makes no request", async () => {
    vi.stubEnv("VOYAGE_API_KEY", "");
    const fetchImpl = vi.fn();
    await expect(
      embedTexts(["x"], { inputType: "query", fetchImpl }),
    ).rejects.toMatchObject({
      code: "provider-misconfigured",
      name: "EmbeddingsError",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an empty texts list is rejected without a request", async () => {
    const fetchImpl = vi.fn();
    await expect(
      embedTexts([], { inputType: "query", fetchImpl }),
    ).rejects.toBeInstanceOf(EmbeddingsError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a non-2xx response is a provider error", async () => {
    await expect(
      embedTexts(["x"], {
        inputType: "query",
        fetchImpl: fakeFetch({ error: "bad key" }, 401),
      }),
    ).rejects.toMatchObject({ code: "provider-error" });
  });

  it("a network failure is a provider error", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(
      embedTexts(["x"], { inputType: "query", fetchImpl }),
    ).rejects.toMatchObject({ code: "provider-error" });
  });

  it("invalid JSON is a provider error", async () => {
    const fetchImpl = (async () =>
      new Response("not json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(
      embedTexts(["x"], { inputType: "query", fetchImpl }),
    ).rejects.toMatchObject({ code: "provider-error" });
  });

  it("a short data array is a provider error, never silently padded", async () => {
    await expect(
      embedTexts(["one", "two"], {
        inputType: "document",
        fetchImpl: fakeFetch(voyageResponse([testVector(0)])),
      }),
    ).rejects.toMatchObject({ code: "provider-error" });
  });

  it("a wrong-dimension embedding is a provider error", async () => {
    await expect(
      embedTexts(["x"], {
        inputType: "query",
        fetchImpl: fakeFetch(voyageResponse([[1, 2, 3]])),
      }),
    ).rejects.toMatchObject({ code: "provider-error" });
  });

  it("a non-finite component is a provider error", async () => {
    const bad = testVector(0);
    bad[1] = Number.NaN;
    await expect(
      embedTexts(["x"], {
        inputType: "query",
        fetchImpl: fakeFetch(voyageResponse([bad])),
      }),
    ).rejects.toMatchObject({ code: "provider-error" });
  });

  it("a missing token count is a provider error", async () => {
    const body = voyageResponse([testVector(0)]);
    delete body.usage;
    await expect(
      embedTexts(["x"], { inputType: "query", fetchImpl: fakeFetch(body) }),
    ).rejects.toMatchObject({ code: "provider-error" });
  });

  it("an explicit apiKey overrides the environment", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(
        (init.headers as Record<string, string>).Authorization,
      );
      return new Response(
        JSON.stringify(voyageResponse([testVector(0)])),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    await embedTexts(["x"], {
      inputType: "query",
      apiKey: "explicit-key",
      fetchImpl,
    });
    expect(seen).toEqual(["Bearer explicit-key"]);
  });
});
