// Model providers + hot-swap failover (2026-11-24).
//
// Primary: Groq `llama-3.3-70b-versatile` via `@ai-sdk/groq`
// (verified: console.groq.com/docs/ai-sdk; env `GROQ_API_KEY`).
// Backup: OpenRouter free `meta-llama/llama-3.3-70b-instruct:free`
// via `@openrouter/ai-sdk-provider` 3.1.0 (verified 2026-11-24:
// the `:free` model has been free since at least April 2026 and is
// still listed as free; a free OpenRouter account gets 50 free-model
// requests/day, 20/minute — see TECH_STACK.md §3.3).
//
// Failover rule (owner decision 2026-11-24): if a model call fails
// with a rate-limit (429) or provider server error (5xx), retry the
// SAME call once on the backup. One backup attempt per chat request
// (the tool loop's calls share one FailoverState), then fail honestly.
// The next request always starts on Groq again — no sticky state.
//
// How it works: the primary model is wrapped with
// `wrapLanguageModel` middleware. The retry happens inside the
// model's `doStream`/`doGenerate`, before any chunk reaches the
// client — so a successful failover streams the backup's answer with
// no error part, and a failed backup surfaces the backup's error
// honestly. A failure AFTER the stream has started (partial text
// already sent) cannot be retried without duplicating text, so it
// fails honestly instead — the wrapper only catches errors thrown
// by `doStream`/`doGenerate` itself.
//
// Logging: every failover is a structured server log line (primary
// status + message, backup outcome). No action_logs row: that table
// is the tool-action audit trail (tool_call_id / tool_name are
// NOT NULL), and a provider switch is not a tool action — forcing a
// fake tool row in would pollute the audit trail. The answering
// provider is surfaced to the owner through /api/health instead
// (see lastAnsweredProvider).
//
// The backup key is optional: with no OPENROUTER_API_KEY, failover
// is simply unavailable and chat behaves exactly as before — the
// primary error surfaces honestly, never a crash or a block.
import { groq } from "@ai-sdk/groq";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel } from "ai";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Middleware,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";

export const PRIMARY_MODEL_ID = "llama-3.3-70b-versatile";
export const BACKUP_MODEL_ID = "meta-llama/llama-3.3-70b-instruct:free";

export type ProviderName = "groq" | "openrouter";

/** Per-request failover state. Created fresh for each chat or resume
 * request and shared by that request's model calls, so the "one
 * backup attempt per request" budget holds across the tool loop. */
export type FailoverState = {
  /** True once the backup has been attempted for this request. */
  usedBackup: boolean;
  /** The provider that answered the most recent call of this request. */
  provider: ProviderName;
};

export function createFailoverState(): FailoverState {
  return { usedBackup: false, provider: "groq" };
}

/** The provider that answered the most recent model call in this
 * server instance, for the Usage panel (via /api/health). Starts as
 * the primary and flips to the backup only when a failover actually
 * answers; flips back on the next Groq success. Resets to Groq on a
 * cold start — the primary is the honest default, since every
 * request starts there. (Per-instance in serverless; a single-user
 * app rarely spans instances.) */
let lastProvider: ProviderName = "groq";

export function lastAnsweredProvider(): ProviderName {
  return lastProvider;
}

/** Only a rate-limit or a provider server error is worth retrying
 * on the backup. Anything else (bad request, bad key, abort) fails
 * honestly on the primary — retrying it elsewhere would hide the
 * real problem. The status comes from the provider error itself
 * (APICallError.statusCode); a message-only guess would misfire. */
export function isRetryableProviderError(error: unknown): boolean {
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof statusCode !== "number") return false;
  return statusCode === 429 || (statusCode >= 500 && statusCode < 600);
}

function errorDetail(error: unknown): { status: number | null; message: string } {
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: typeof statusCode === "number" ? statusCode : null,
    message: message.slice(0, 200),
  };
}

/** The backup model, or null when no backup key is configured.
 * Read at call time (not import time) so tests and deploys can
 * change the environment without a restart. */
export function backupModel(): LanguageModelV4 | null {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || key.trim() === "") return null;
  return createOpenRouter({ apiKey: key })(BACKUP_MODEL_ID);
}

/** One failover attempt for a failed primary call. Returns the
 * backup's result, or rethrows the primary error when there is no
 * backup to try (no key, budget already used, or a non-retryable
 * error). The backup's own failure is logged and rethrown — the
 * caller sees the real error, never a synthetic one. */
async function failoverStream(
  error: unknown,
  state: FailoverState,
  params: LanguageModelV4CallOptions,
): Promise<LanguageModelV4StreamResult> {
  const detail = errorDetail(error);
  if (!isRetryableProviderError(error) || state.usedBackup) throw error;
  const backup = backupModel();
  if (backup === null) {
    console.error(
      `[provider-failover] groq failed (${detail.status ?? "no-status"}: ${detail.message}) — no OPENROUTER_API_KEY, failover unavailable`,
    );
    throw error;
  }
  state.usedBackup = true;
  console.error(
    `[provider-failover] groq failed (${detail.status}: ${detail.message}) — retrying once on openrouter ${BACKUP_MODEL_ID}`,
  );
  try {
    const result = await backup.doStream(params);
    state.provider = "openrouter";
    lastProvider = "openrouter";
    console.error("[provider-failover] openrouter answered after groq failure");
    return result;
  } catch (backupError) {
    const backupDetail = errorDetail(backupError);
    console.error(
      `[provider-failover] openrouter also failed (${backupDetail.status ?? "no-status"}: ${backupDetail.message}) — failing honestly`,
    );
    throw backupError;
  }
}

async function failoverGenerate(
  error: unknown,
  state: FailoverState,
  params: LanguageModelV4CallOptions,
): Promise<LanguageModelV4GenerateResult> {
  const detail = errorDetail(error);
  if (!isRetryableProviderError(error) || state.usedBackup) throw error;
  const backup = backupModel();
  if (backup === null) {
    console.error(
      `[provider-failover] groq failed (${detail.status ?? "no-status"}: ${detail.message}) — no OPENROUTER_API_KEY, failover unavailable`,
    );
    throw error;
  }
  state.usedBackup = true;
  console.error(
    `[provider-failover] groq failed (${detail.status}: ${detail.message}) — retrying once on openrouter ${BACKUP_MODEL_ID}`,
  );
  try {
    const result = await backup.doGenerate(params);
    state.provider = "openrouter";
    lastProvider = "openrouter";
    console.error("[provider-failover] openrouter answered after groq failure");
    return result;
  } catch (backupError) {
    const backupDetail = errorDetail(backupError);
    console.error(
      `[provider-failover] openrouter also failed (${backupDetail.status ?? "no-status"}: ${backupDetail.message}) — failing honestly`,
    );
    throw backupError;
  }
}

/** The chat model: Groq primary with one hot-swap attempt to the
 * OpenRouter free backup per request. Every request starts on Groq;
 * the state records which provider actually answered, so the route
 * can report it honestly. */
export function chatModel(state: FailoverState): LanguageModelV4 {
  const middleware: LanguageModelV4Middleware = {
    specificationVersion: "v4",
    wrapStream: async ({ doStream, params }) => {
      try {
        const result = await doStream();
        state.provider = "groq";
        lastProvider = "groq";
        return result;
      } catch (error) {
        return failoverStream(error, state, params);
      }
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      try {
        const result = await doGenerate();
        state.provider = "groq";
        lastProvider = "groq";
        return result;
      } catch (error) {
        return failoverGenerate(error, state, params);
      }
    },
  };
  return wrapLanguageModel({ model: groq(PRIMARY_MODEL_ID), middleware });
}
