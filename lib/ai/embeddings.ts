// Embeddings provider (vector memory RAG, 2026-11-25).
//
// Plain language: this is the only place that talks to the embeddings
// provider. It turns text into a list of 512 numbers (a vector) that
// places the text in a meaning space, so the database can later find
// the memories and document pages closest in meaning to a question.
// It never decides what a result means, and it never stores anything
// — the caller writes the returned vectors into the database.
//
// Provider choice (verified 2026-11-25 against the vendors' own docs
// and pricing pages — see PROGRESS.md for the full comparison):
// Voyage AI, model `voyage-4-lite`, is the pick of the three
// candidates the task named:
//   - OpenAI text-embedding-3-small: $0.02/1M tokens, 1536 dims — but
//     NO free tier (only one-off trial credits on a new account). A
//     single-user app would pay from the first token.
//   - Cohere Embed: trial key capped at 1,000 API calls/month AND
//     barred from production/commercial use; paid Embed 5 is
//     $0.08–0.12/1M. The trial's no-production rule disqualifies it
//     for a live app.
//   - Voyage voyage-4-lite: $0.02/1M tokens AFTER the first 200M
//     tokens free per account (current generation — the older voyage-3
//     series no longer carries free tokens, so the 4-series matters).
//     32,000-token context, Matryoshka dimensions (256/512/1024/2048),
//     input_type "query"/"document" for retrieval. At this app's scale
//     (tens of memories, hundreds of pages) the 200M free tokens are
//     effectively inexhaustible: a memory is ~tens of tokens, a page
//     ~hundreds.
//   The 512-dimension choice: voyage-4-lite defaults to 1024, but
//   output_dimension 512 halves pgvector/real[] storage against 1024
//   and thirds it against OpenAI's 1536, with minimal retrieval loss
//   (Matryoshka packs the most important signal into the first
//   dimensions). The database CHECKs pin 512, so the model and the
//   schema cannot drift apart silently.
//
// Privacy caveat, stated honestly: Voyage's terms make training on
// customer data the default, and opting out needs a card on file.
// The non-sensitive-only rule therefore covers embeddings exactly as
// it covers chat and memories (lib/memories.ts): only non-sensitive
// facts belong in memories, and only the owner's own documents are
// embedded. If that ever becomes unacceptable, the provider can be
// swapped here — the rest of the code only sees embedTexts().
//
// Server-only: the key is read from the server environment
// (VOYAGE_API_KEY, never NEXT_PUBLIC_) at call time, so it never
// reaches the browser. Create the key at dashboard.voyageai.com
// (API Keys) — a dashboard key (prefix `pa-`) talks to
// https://api.voyageai.com/v1, which is the base URL below. A
// MongoDB-Atlas-issued key (prefix `al-`) talks to ai.mongodb.com
// instead and will NOT work here.
//
// Errors are typed, never leaked raw: a missing key is a
// pre-dispatch abort (the caller treats it as "embeddings
// unavailable" and falls back), while a provider failure after
// dispatch is not refunded or retried — the caller logs it and the
// row simply stays unembedded.
export const EMBEDDING_MODEL = "voyage-4-lite";

/** Dimensions every embedding in this app has; pinned by the DB CHECKs. */
export const EMBEDDING_DIMENSIONS = 512;

/** Voyage embeddings endpoint (docs.voyageai.com/reference/embeddings-api). */
export const EMBEDDINGS_API_URL = "https://api.voyageai.com/v1/embeddings";

/** Texts per request. Voyage allows up to 1,000 texts / 1M tokens per
 * request for the lite models; 128 keeps each request small and a
 * single failure cheap (the backfill script batches at this size). */
export const MAX_EMBEDDING_BATCH = 128;

export type EmbeddingsErrorCode = "provider-misconfigured" | "provider-error";

export class EmbeddingsError extends Error {
  readonly code: EmbeddingsErrorCode;

  constructor(code: EmbeddingsErrorCode, message: string) {
    super(message);
    this.name = "EmbeddingsError";
    this.code = code;
  }
}

/** Retrieval role of the text: "query" for a question being asked,
 * "document" for text being stored and searched over. Voyage
 * prepends a different prompt per role, so the two must not be
 * mixed — a stored fact embedded as a query would live in the wrong
 * part of the space. */
export type EmbeddingInputType = "query" | "document";

export interface EmbeddingsUsage {
  /** Input tokens the provider counted for this call (its own
   * metering — the source of truth for cost; FLASH keeps no meter
   * of its own, so this is logged by callers, never displayed). */
  totalTokens: number;
}

export interface EmbeddingsResult {
  /** One vector per input text, in input order. */
  embeddings: number[][];
  usage: EmbeddingsUsage;
}

/** True when a Voyage key is configured, so an embedding can actually
 * run. Read at call time, not import time, so tests and deploys can
 * change the environment without a restart. */
export function isEmbeddingsAvailable(): boolean {
  const key = process.env.VOYAGE_API_KEY;
  return key !== undefined && key.trim() !== "";
}

/** Embed one or more texts. `apiKey` and `fetchImpl` are injectable
 * so tests can run without a key or a network; in production both
 * default to the server environment and the global fetch.
 *
 * Validates the response shape strictly: the provider must return
 * exactly one embedding per input text, each of EMBEDDING_DIMENSIONS
 * finite numbers. A short or misshapen response is a provider error,
 * never silently padded — a fake or truncated vector would poison
 * retrieval with confident-looking nonsense. */
export async function embedTexts(
  texts: string[],
  opts: {
    inputType: EmbeddingInputType;
    apiKey?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<EmbeddingsResult> {
  if (texts.length === 0) {
    throw new EmbeddingsError("provider-error", "Nothing to embed.");
  }
  const apiKey = opts.apiKey ?? process.env.VOYAGE_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new EmbeddingsError(
      "provider-misconfigured",
      "VOYAGE_API_KEY is not set.",
    );
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(EMBEDDINGS_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: texts,
        model: EMBEDDING_MODEL,
        input_type: opts.inputType,
        output_dimension: EMBEDDING_DIMENSIONS,
        truncation: true,
      }),
    });
  } catch (err) {
    throw new EmbeddingsError(
      "provider-error",
      `Voyage request failed: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }
  if (!response.ok) {
    throw new EmbeddingsError(
      "provider-error",
      `Voyage returned HTTP ${response.status}.`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new EmbeddingsError(
      "provider-error",
      "Voyage returned invalid JSON.",
    );
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new EmbeddingsError(
      "provider-error",
      "Voyage returned an unexpected response shape.",
    );
  }
  const embeddings: number[][] = data.map((item) => {
    const embedding = (item as { embedding?: unknown }).embedding;
    if (
      !Array.isArray(embedding) ||
      embedding.length !== EMBEDDING_DIMENSIONS ||
      !embedding.every(
        (n) => typeof n === "number" && Number.isFinite(n),
      )
    ) {
      throw new EmbeddingsError(
        "provider-error",
        "Voyage returned an embedding with the wrong shape.",
      );
    }
    return embedding as number[];
  });
  const totalTokens = (body as { usage?: { total_tokens?: unknown } }).usage
    ?.total_tokens;
  if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens)) {
    throw new EmbeddingsError(
      "provider-error",
      "Voyage returned no usable token count.",
    );
  }
  return { embeddings, usage: { totalTokens } };
}

/** Embed a single question for retrieval (input_type "query"). */
export async function embedQuery(
  text: string,
  opts: { apiKey?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ embedding: number[]; usage: EmbeddingsUsage }> {
  const result = await embedTexts([text], {
    inputType: "query",
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });
  return { embedding: result.embeddings[0], usage: result.usage };
}

/** Embed stored texts for retrieval (input_type "document"). */
export async function embedDocuments(
  texts: string[],
  opts: { apiKey?: string; fetchImpl?: typeof fetch } = {},
): Promise<EmbeddingsResult> {
  return embedTexts(texts, {
    inputType: "document",
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });
}
