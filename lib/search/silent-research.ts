// Silent web research (owner-directed feature batch, 2026-11-24).
//
// Plain language: when a question needs current or external
// information, FLASH runs one background Tavily search BEFORE
// answering and feeds the findings to the model as context. The
// owner never asked for a search, so the transcript stays clean:
// the findings go into the model's instructions, never into the
// chat as a pasted block, and the reply carries only a small
// "researched the web" indicator (see lib/chat-history.ts and
// components/chat.tsx).
//
// Trigger (shouldResearch): a cheap heuristic, deliberately NOT a
// model judgement call — a judgement call would cost a Groq request
// on every turn, and the model already has the web_search tool for
// the ambiguous cases. The heuristic is conservative: it fires on
// recency signals (latest/news/today/a 2026+ year), explicit
// "search the web" asks, and price/release/external-fact questions,
// and it NEVER fires for document questions (the document is the
// source of truth), for questions about the owner's own data
// (memories, notes, tasks, documents, schedule), for greetings and
// small talk, or for questions about FLASH itself. At most ONE
// Tavily search per turn, basic search only (1 credit).
//
// Accounting: a run uses the SAME record_search / refund_search /
// log_read_only_action path as the model-invoked web_search tool
// (lib/tools/execute-tool-call.ts) — one counter, one audit trail,
// no second meter. The log row carries tool "web_search" with
// params { query, mode: "silent" } and result { resultCount,
// sources }, so the activity timeline shows the query, the result
// count, the timestamp, and the conversation. The tool_call_id is
// synthetic ("silent-<uuid>") because no model tool call exists;
// action_logs.tool_call_id is NOT NULL, so a null is not an option.
//
// Honest-data rule: a missing TAVILY_API_KEY means research is
// simply unavailable — no record, no log row, no indicator, no
// crash, never a faked result. A provider failure after dispatch
// is counted and logged as failed, never refunded (same rule as
// the model-call record). An empty result list is logged as a
// success with resultCount 0 and returns "empty": the reply is
// NOT marked as researched, because nothing useful was found.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { randomUUID } from "node:crypto";
import { toJson } from "@/lib/json";
import {
  searchTavily,
  TavilyError,
  type SearchProvider,
} from "@/lib/search/tavily";
import {
  executeWebSearch,
  type WebSearchOutput,
} from "@/lib/tools/read-only";

/** The user question is truncated to this many characters before it
 * becomes the Tavily query: a long pasted question still searches,
 * but the audit row stays small. */
export const SILENT_RESEARCH_QUERY_LIMIT = 500;

/** The log row's tool name: the same "web_search" the model-invoked
 * tool logs, so the timeline and the meter see one kind of search.
 * The params carry mode: "silent" to tell the two apart. */
export const SILENT_RESEARCH_TOOL = "web_search";

// --- Trigger -----------------------------------------------------------

/** Questions about the owner's own data: the answer comes from
 * memories, notes, documents, or tasks — never from the web. */
const PERSONAL_DATA_PATTERNS: RegExp[] = [
  /\b(my|our)\s+(notes?|memor(y|ies)|tasks?|documents?|files?|schedule|calendar|reminders?|journal|diary)\b/i,
  /\bremember\s+(that|when|the|what)\b/i,
  /\bwhat did i\b/i,
  /\bdo i have\b/i,
  /\bwhat('s| is) (on|in) my\b/i,
  /\bwho am i\b/i,
  /\bmy (name|email|phone|address)\b/i,
];

/** Greetings, thanks, and questions about FLASH itself: no external
 * facts are needed to answer these. */
const SMALL_TALK_PATTERNS: RegExp[] = [
  /^(hi|hii+|hello|hey|yo|good\s(morning|afternoon|evening)|thanks|thank\syou|ok|okay|bye|goodbye)\b/i,
  /\bhow are you\b/i,
  /\bwho are you\b/i,
  /\bwhat can you do\b/i,
];

/** Signals that the answer needs current or external information. */
const RESEARCH_SIGNALS: RegExp[] = [
  // The owner explicitly asked for a search.
  /\b(search|google|look\s+up|check)\b.{0,30}\b(web|online|internet)\b/i,
  /\bsearch the web\b/i,
  /\blook\s+(it|this|that)\s+up\b/i,
  // Recency: the answer changes with time.
  /\b(latest|newest|recent|currently|today|tonight|this\s(week|month|year)|breaking|right\snow)\b/i,
  /\bjust\s(announced|released|launched|happened|dropped)\b/i,
  // A 2026+ year: almost always a current-facts question.
  /\b20(2[6-9]|3\d)\b/,
  // News, weather, scores: live data by definition.
  /\b(news|headlines?|weather|forecast)\b/i,
  /\b(score|match\sresult|who\s+won)\b/i,
  // Prices, releases, availability: external facts that move.
  /\b(price|cost|how\smuch\s(is|does|do)|cheapest|discount)\b/i,
  /\b(release|launch)\s+date\b/i,
  /\bwhen\s+(is|does|will)\b.{0,50}\b(release|launch|come\sout|start|happen)\b/i,
  /\bis\b.{0,40}\b(available|out|released|still\s+(on|available))\b/i,
  /\bwhat\s(is|are)\s+the\s(latest|current)\b/i,
];

/**
 * Whether this user turn warrants a background search. Pure: no I/O,
 * no model call, no key check — the caller checks the key separately
 * (a warranted turn with no key is simply unavailable, not an error).
 *
 * `hasDocument` is true when the turn asks about one of the owner's
 * documents: the document is the source of truth, so the web is
 * never consulted for it.
 */
export function shouldResearch(
  question: string,
  opts: { hasDocument?: boolean } = {},
): boolean {
  if (opts.hasDocument === true) return false;
  const text = question.trim();
  if (text.length < 3) return false;
  if (PERSONAL_DATA_PATTERNS.some((re) => re.test(text))) return false;
  if (SMALL_TALK_PATTERNS.some((re) => re.test(text))) return false;
  return RESEARCH_SIGNALS.some((re) => re.test(text));
}

/** True when a Tavily key is configured, so a search can actually
 * run. Read at call time, not import time, so tests and deploys can
 * change the environment without a restart. */
export function isResearchAvailable(): boolean {
  const key = process.env.TAVILY_API_KEY;
  return key !== undefined && key.trim() !== "";
}

// --- Execution ---------------------------------------------------------

export interface SilentResearchSource {
  title: string;
  url: string;
}

export type SilentResearchResult =
  | {
      status: "ok";
      query: string;
      sources: SilentResearchSource[];
      resultCount: number;
      /** The delimited untrusted-data block for the model's context. */
      contextBlock: string;
    }
  | { status: "unavailable" }
  | { status: "failed" }
  | { status: "empty" };

export interface SilentResearchDeps {
  /** Service-role client: record_search / refund_search /
   * log_read_only_action are service-role only. */
  admin: SupabaseClient<Database>;
  userId: string;
  conversationId: string;
  query: string;
  /** Injectable provider for tests; defaults to the real Tavily adapter. */
  searchProvider?: SearchProvider;
}

/** The context block for the model's instructions: one honest line
 * naming the query, then the delimited untrusted-data block from
 * executeWebSearch. The model is told to use the results only if
 * they help — never to claim a search ran on its own say-so (the
 * system prompt carries the same rule). */
export function buildResearchContextBlock(
  query: string,
  output: WebSearchOutput,
): string {
  return [
    `Background web research for "${query}" — run silently before answering because the question needed current or external information. Use these results only if they help answer the question.`,
    output.content,
  ].join("\n");
}

/** One audit row in action_logs for a silent research run. A failed
 * log is console.error only, never fatal: the reply must not fail
 * because the audit write did. */
async function logResearch(
  admin: SupabaseClient<Database>,
  userId: string,
  conversationId: string,
  query: string,
  status: "succeeded" | "failed",
  result: Record<string, unknown>,
): Promise<void> {
  try {
    await admin.rpc("log_read_only_action", {
      p_user_id: userId,
      p_conversation_id: conversationId,
      // No model tool call exists for a silent run; the id is
      // synthetic and unique per run. action_logs.tool_call_id is
      // NOT NULL, so a null is not an option.
      p_tool_call_id: `silent-${randomUUID()}`,
      p_tool: SILENT_RESEARCH_TOOL,
      p_params: toJson({ query, mode: "silent" }),
      p_status: status,
      p_result: toJson(result),
    });
  } catch (err) {
    console.error("Failed to log silent research", err);
  }
}

/**
 * Run one silent research step for a user turn: record the search
 * against the monthly meter, call Tavily (basic, 1 credit), log the
 * run, and return the findings for the model's context.
 *
 * The record happens first and unconditionally (same as web_search):
 * a record failure means the search is refused honestly, so the
 * meter can never under-count a search that ran. A missing key is
 * checked before the record — nothing was sent, so nothing is
 * counted and nothing is logged. A provider failure after dispatch
 * is counted and logged as failed, never refunded.
 */
export async function runSilentResearch(
  deps: SilentResearchDeps,
): Promise<SilentResearchResult> {
  const { admin, userId, conversationId } = deps;
  const query = deps.query.trim().slice(0, SILENT_RESEARCH_QUERY_LIMIT);
  if (query === "") return { status: "unavailable" };
  if (!isResearchAvailable()) return { status: "unavailable" };

  const { data: recorded, error: recordError } = await admin.rpc(
    "record_search",
    { p_user_id: userId },
  );
  if (recordError !== null) {
    console.error("Silent research record failed", recordError);
    await logResearch(admin, userId, conversationId, query, "failed", {
      error: "search_unavailable",
    });
    return { status: "unavailable" };
  }
  const recordedRow =
    recorded && (recorded as Array<{ usage_date?: string }>).length === 1
      ? (recorded as Array<{ usage_date: string }>)[0]
      : undefined;
  if (!recordedRow) {
    await logResearch(admin, userId, conversationId, query, "failed", {
      error: "search_unavailable",
    });
    return { status: "unavailable" };
  }
  const usageDate = recordedRow.usage_date;

  try {
    const output = await executeWebSearch(
      query,
      deps.searchProvider ?? searchTavily,
    );
    if (output.sources.length === 0) {
      // The provider answered with nothing useful: the search still
      // cost its credit, so the record stands — but the reply is
      // NOT marked as researched.
      await logResearch(admin, userId, conversationId, query, "succeeded", {
        resultCount: 0,
        sources: [],
        note: "no useful results",
      });
      return { status: "empty" };
    }
    await logResearch(admin, userId, conversationId, query, "succeeded", {
      resultCount: output.sources.length,
      sources: output.sources,
    });
    return {
      status: "ok",
      query,
      sources: output.sources,
      resultCount: output.sources.length,
      contextBlock: buildResearchContextBlock(query, output),
    };
  } catch (err) {
    // A pre-dispatch abort (the key vanished between the check and
    // the call) refunds the record: nothing was sent, so the search
    // did not happen. A provider failure after dispatch is NOT
    // refunded — the same rule as the model-call record.
    if (err instanceof TavilyError && err.code === "provider-misconfigured") {
      try {
        await admin.rpc("refund_search", {
          p_user_id: userId,
          p_usage_date: usageDate,
        });
      } catch (refundErr) {
        console.error("Failed to refund silent research record", refundErr);
      }
      await logResearch(admin, userId, conversationId, query, "failed", {
        error: "search_unavailable",
      });
      return { status: "unavailable" };
    }
    await logResearch(admin, userId, conversationId, query, "failed", {
      error: "search_unavailable",
    });
    console.error("Silent research failed", err);
    return { status: "failed" };
  }
}
