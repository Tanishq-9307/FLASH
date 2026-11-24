// Provider hot-swap failover tests (2026-11-24): Groq primary,
// OpenRouter free backup. The models are mocked (MockLanguageModelV4)
// so no real quota is used; the middleware in lib/ai/provider.ts is
// real. The fake backup key below is a test-only placeholder, never
// a real key.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamText } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import {
  BACKUP_MODEL_ID,
  PRIMARY_MODEL_ID,
  chatModel,
  createFailoverState,
  isRetryableProviderError,
  lastAnsweredProvider,
} from "@/lib/ai/provider";

// Hoisted holders: vi.mock factories run before imports, so shared
// mutable state must live in vi.hoisted.
const testState = vi.hoisted(() => ({
  primaryMode: "ok" as "ok" | "error429" | "error500" | "error400",
  backupMode: "ok" as "ok" | "error500",
  primaryDoStreamCalls: 0,
  backupDoStreamCalls: 0,
  groqModelId: null as unknown,
  openRouterModelId: null as unknown,
  openRouterKeyPresent: false,
}));

function chunksFor(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
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
}

function providerError(statusCode: number): Error & { statusCode: number } {
  const err = new Error(`provider ${statusCode}`) as Error & {
    statusCode: number;
  };
  err.statusCode = statusCode;
  return err;
}

vi.mock("@ai-sdk/groq", () => ({
  groq: (modelId: unknown) => {
    testState.groqModelId = modelId;
    return new MockLanguageModelV4({
      doStream: async () => {
        testState.primaryDoStreamCalls += 1;
        if (testState.primaryMode === "error429") throw providerError(429);
        if (testState.primaryMode === "error500") throw providerError(500);
        if (testState.primaryMode === "error400") throw providerError(400);
        return { stream: simulateReadableStream({ chunks: chunksFor("Hello from Groq") }) };
      },
    });
  },
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: (options: { apiKey?: unknown }) => {
    testState.openRouterKeyPresent = typeof options.apiKey === "string" && options.apiKey.length > 0;
    return (modelId: unknown) => {
      testState.openRouterModelId = modelId;
      return new MockLanguageModelV4({
        doStream: async () => {
          testState.backupDoStreamCalls += 1;
          if (testState.backupMode === "error500") throw providerError(500);
          return { stream: simulateReadableStream({ chunks: chunksFor("Hello from OpenRouter") }) };
        },
      });
    };
  },
}));

describe("isRetryableProviderError", () => {
  it("retries 429 and 5xx only", () => {
    expect(isRetryableProviderError(providerError(429))).toBe(true);
    expect(isRetryableProviderError(providerError(500))).toBe(true);
    expect(isRetryableProviderError(providerError(503))).toBe(true);
    expect(isRetryableProviderError(providerError(400))).toBe(false);
    expect(isRetryableProviderError(providerError(401))).toBe(false);
    expect(isRetryableProviderError(new Error("boom"))).toBe(false);
    expect(isRetryableProviderError(undefined)).toBe(false);
  });
});

describe("chatModel failover", () => {
  beforeEach(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    testState.primaryMode = "ok";
    testState.backupMode = "ok";
    testState.primaryDoStreamCalls = 0;
    testState.backupDoStreamCalls = 0;
    testState.groqModelId = null;
    testState.openRouterModelId = null;
    testState.openRouterKeyPresent = false;
  });

  async function ask(state: ReturnType<typeof createFailoverState>) {
    const result = streamText({
      model: chatModel(state),
      prompt: "hi",
      maxRetries: 0,
    });
    return { result, text: await result.text };
  }

  it("primary ok → Groq answers, backup never called", async () => {
    const state = createFailoverState();
    const { text } = await ask(state);
    expect(text).toBe("Hello from Groq");
    expect(state.provider).toBe("groq");
    expect(state.usedBackup).toBe(false);
    expect(testState.primaryDoStreamCalls).toBe(1);
    expect(testState.backupDoStreamCalls).toBe(0);
    expect(testState.groqModelId).toBe(PRIMARY_MODEL_ID);
    expect(lastAnsweredProvider()).toBe("groq");
  });

  it("primary 429 → backup answers, once", async () => {
    testState.primaryMode = "error429";
    const state = createFailoverState();
    const { text } = await ask(state);
    expect(text).toBe("Hello from OpenRouter");
    expect(state.provider).toBe("openrouter");
    expect(state.usedBackup).toBe(true);
    expect(testState.primaryDoStreamCalls).toBe(1);
    expect(testState.backupDoStreamCalls).toBe(1);
    expect(testState.openRouterModelId).toBe(BACKUP_MODEL_ID);
    expect(testState.openRouterKeyPresent).toBe(true);
    expect(lastAnsweredProvider()).toBe("openrouter");
  });

  it("primary 500 → backup answers", async () => {
    testState.primaryMode = "error500";
    const state = createFailoverState();
    const { text } = await ask(state);
    expect(text).toBe("Hello from OpenRouter");
    expect(state.provider).toBe("openrouter");
    expect(testState.primaryDoStreamCalls).toBe(1);
    expect(testState.backupDoStreamCalls).toBe(1);
  });

  it("backup also failing → honest error, exactly one backup attempt", async () => {
    testState.primaryMode = "error429";
    testState.backupMode = "error500";
    const state = createFailoverState();
    const result = streamText({
      model: chatModel(state),
      prompt: "hi",
      maxRetries: 0,
    });
    await expect(result.text).rejects.toThrow();
    expect(testState.primaryDoStreamCalls).toBe(1);
    expect(testState.backupDoStreamCalls).toBe(1);
    expect(state.usedBackup).toBe(true);
  });

  it("recovery → the next request starts on Groq again", async () => {
    testState.primaryMode = "error429";
    const first = createFailoverState();
    const failed = await ask(first);
    expect(failed.text).toBe("Hello from OpenRouter");
    expect(testState.backupDoStreamCalls).toBe(1);

    // Groq recovers: a fresh request answers from the primary and
    // never touches the backup.
    testState.primaryMode = "ok";
    const second = createFailoverState();
    const recovered = await ask(second);
    expect(recovered.text).toBe("Hello from Groq");
    expect(second.provider).toBe("groq");
    expect(testState.backupDoStreamCalls).toBe(1);
    expect(lastAnsweredProvider()).toBe("groq");
  });

  it("one backup attempt per request, shared across calls", async () => {
    testState.primaryMode = "error429";
    const state = createFailoverState();
    const first = await ask(state);
    expect(first.text).toBe("Hello from OpenRouter");
    // A second call in the same request (e.g. the tool loop's next
    // step) gets no further backup attempt once the budget is used.
    testState.backupMode = "error500";
    const result = streamText({
      model: chatModel(state),
      prompt: "hi again",
      maxRetries: 0,
    });
    await expect(result.text).rejects.toThrow();
    expect(testState.primaryDoStreamCalls).toBe(2);
    expect(testState.backupDoStreamCalls).toBe(1);
  });

  it("missing backup key → primary error surfaces honestly, backup never built", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    testState.primaryMode = "error429";
    const state = createFailoverState();
    const result = streamText({
      model: chatModel(state),
      prompt: "hi",
      maxRetries: 0,
    });
    await expect(result.text).rejects.toThrow();
    expect(testState.primaryDoStreamCalls).toBe(1);
    expect(testState.backupDoStreamCalls).toBe(0);
    expect(state.usedBackup).toBe(false);
  });

  it("non-retryable primary error (400) → no backup attempt", async () => {
    testState.primaryMode = "error400";
    const state = createFailoverState();
    const result = streamText({
      model: chatModel(state),
      prompt: "hi",
      maxRetries: 0,
    });
    await expect(result.text).rejects.toThrow();
    expect(testState.primaryDoStreamCalls).toBe(1);
    expect(testState.backupDoStreamCalls).toBe(0);
    expect(state.usedBackup).toBe(false);
  });
});
