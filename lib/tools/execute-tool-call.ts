// One model tool call, executed server-side (M3-17, M3-18).
//
// Plain language: the model never runs a tool itself — the loop
// hands each call here, and this decides what happens to it:
//   - unknown tool name, or arguments that fail the registry's Zod
//     schema → an error result goes back to the model, and nothing
//     runs. No log row either: nothing was executed, so there is no
//     action to audit (the tool-call message the loop persists still
//     records the attempt).
//   - state-changing tool (create_task, save_memory) → the server
//     records a proposal with create_pending_approval (service role)
//     and NOTHING is executed. The outcome is approval_created with
//     the approval id — the loop then ends the stream with a data part
//     carrying only that id. If an approval is already open in this
//     conversation, create_pending_approval returns
//     open_approval_exists and the model gets a discarded error result
//     instead, so it can ask the owner to resolve the open dialog.
//   - read-only tool (get_tasks, web_search) → run with the
//     user-scoped client (get_tasks) or the search provider
//     (web_search, after recording one search for the monthly meter),
//     log the outcome via log_read_only_action (succeeded with the
//     result, or failed with a generic error), and return the result
//     to the model. A query failure is reported honestly as
//     query_failed and a search failure as search_unavailable — never
//     with internals, and never with invented tasks or results.
//     There is no search cap any more (owner decision 2026-11-24):
//     the monthly limit is a display limit only.
//
// The return is a discriminated outcome: either a tool-result part
// for the model's next message, or an approval_created outcome the
// loop ends the stream on — plus a one-line summary the loop persists
// as the message text. A created approval has no tool-result part:
// the stream ends and the model never sees one.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolResultPart } from "ai";
import type { Database } from "@/types/supabase";
import { approvalTtlSeconds } from "@/lib/config";
import { toJson } from "@/lib/json";
import {
  clarificationFor,
  parseReminderTime,
} from "@/lib/reminders/parse-time";
import {
  searchTavily,
  TavilyError,
  type SearchProvider,
} from "@/lib/search/tavily";
import { validateToolCall } from "./registry";
import { executeGetTasks, executeWebSearch } from "./read-only";

export interface ToolCallInput {
  toolCallId: string;
  toolName: string;
  /** The model's raw arguments (already parsed from JSON by the SDK). */
  input: unknown;
}

export type ExecutedToolCall =
  | {
      outcome: "tool_result";
      /** The tool-result part for the model's next message. */
      result: ToolResultPart;
      /** One honest line about what happened, for the persisted message. */
      summary: string;
    }
  | {
      outcome: "approval_created";
      /** The pending approval's id — the loop ends the stream with it. */
      approvalId: string;
      /** One honest line about what was proposed, for the persisted message. */
      summary: string;
    };

export interface ToolCallClients {
  /** User-scoped client: RLS proves ownership on every read. */
  supabase: SupabaseClient<Database>;
  /** Admin client (service role): for the audit log and approvals. */
  admin: SupabaseClient<Database>;
}

/** Injectable dependencies for tests. The search provider defaults
 * to the real Tavily adapter; tests pass a fake so no network or key
 * is needed. */
export interface ToolCallDeps {
  searchProvider?: SearchProvider;
}

function errorResult(
  call: ToolCallInput,
  value: Record<string, unknown>,
): ToolResultPart {
  return {
    type: "tool-result",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: { type: "error-json", value: toJson(value) },
  };
}

/** The persisted summary for a proposal, built from the validated
 * parameters only — the dialog the owner sees renders the same values
 * from the stored database snapshot, never from the model. */
function proposalSummary(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "create_task") {
    const title = String(args.title ?? "");
    const due =
      typeof args.due_date === "string" && args.due_date !== ""
        ? ` (due ${args.due_date})`
        : "";
    return `Proposed creating task "${title}"${due}. Waiting for your approval.`;
  }
  if (toolName === "create_reminder") {
    const message = String(args.message ?? "");
    const at =
      typeof args.remind_at === "string" && args.remind_at !== ""
        ? ` at ${args.remind_at}`
        : "";
    return `Proposed setting a reminder "${message}"${at}. Waiting for your approval.`;
  }
  const fact = String(args.fact ?? "");
  const shown = fact.length > 200 ? `${fact.slice(0, 200)}…` : fact;
  return `Proposed saving a memory: "${shown}". Waiting for your approval.`;
}

export async function executeToolCall(
  clients: ToolCallClients,
  userId: string,
  conversationId: string,
  call: ToolCallInput,
  deps: ToolCallDeps = {},
): Promise<ExecutedToolCall> {
  const validated = validateToolCall(call.toolName, call.input);
  if (!validated.ok) {
    return {
      outcome: "tool_result",
      result: errorResult(call, {
        error: validated.error,
        ...(validated.details !== undefined
          ? { details: validated.details }
          : {}),
      }),
      summary: `Called ${call.toolName} with invalid arguments.`,
    };
  }

  if (validated.tool.kind === "state-changing") {
    // create_reminder: the model gives the time in the owner's own
    // words ("tomorrow at 9am"), so it is parsed here, server-side,
    // before anything is proposed. An unparseable time never reaches
    // the approval: the model gets an error result and asks the owner
    // for clarification instead of the server guessing a time. A
    // parsed time is stored as a concrete remind_at, so the approval
    // dialog and the database both see the exact instant.
    let approvalArgs: Record<string, unknown> = validated.args as Record<
      string,
      unknown
    >;
    if (validated.tool.name === "create_reminder") {
      const args = validated.args as { message: string; time_text: string };
      const parsed = parseReminderTime(args.time_text, new Date());
      if (!parsed.ok) {
        return {
          outcome: "tool_result",
          result: errorResult(call, {
            error: "unparseable_time",
            message: clarificationFor("no_time"),
          }),
          summary: `Could not tell when "${args.time_text}" means, so no reminder was proposed.`,
        };
      }
      approvalArgs = {
        message: args.message,
        remind_at: parsed.at.toISOString(),
      };
    }

    // M3-18: record the proposal — never execute. The database
    // stores the exact validated parameters and their hash, and
    // refuses the proposal if an approval is already open.
    try {
      const { data, error } = await clients.admin.rpc(
        "create_pending_approval",
        {
          p_user_id: userId,
          p_conversation_id: conversationId,
          p_tool_call_id: call.toolCallId,
          p_tool: call.toolName,
          p_params: toJson(approvalArgs),
          p_ttl_seconds: approvalTtlSeconds(),
        },
      );
      if (error !== null || data === null || data.length !== 1) {
        throw new Error(
          `create_pending_approval failed: ${error?.message ?? "no row returned"}`,
        );
      }
      const row = data[0] as {
        result_code: string;
        approval_id: string | null;
      };
      if (row.result_code === "created" && row.approval_id !== null) {
        return {
          outcome: "approval_created",
          approvalId: row.approval_id,
          summary: proposalSummary(call.toolName, approvalArgs),
        };
      }
      if (row.result_code === "open_approval_exists") {
        // The proposal is discarded: the model gets an error result
        // and can ask the owner to resolve the open dialog. Nothing
        // was created and nothing was executed.
        return {
          outcome: "tool_result",
          result: errorResult(call, {
            error: "open_approval_exists",
            message:
              "An approval is already open in this conversation. Ask the owner to approve or reject it before proposing anything else.",
          }),
          summary:
            "Proposal discarded — an approval is already open in this conversation.",
        };
      }
      throw new Error(
        `create_pending_approval returned unknown result_code: ${row.result_code}`,
      );
    } catch (err) {
      // The proposal could not be recorded. The model gets a generic
      // error result so the turn stays alive and it can tell the owner
      // the proposal did not go through; the database error itself is
      // logged server-side only, never sent to the model.
      console.error("Proposal could not be recorded", err);
      return {
        outcome: "tool_result",
        result: errorResult(call, { error: "proposal_failed" }),
        summary: `Proposed ${call.toolName}, but the proposal could not be recorded.`,
      };
    }
  }

  // Read-only, web_search: record one search first, then call the
  // provider. The record is unconditional (owner decision 2026-11-24:
  // no daily search cap — the monthly limit is a display limit only),
  // so a record failure is reported honestly as search_unavailable
  // and logged as a failure. A missing provider key is a pre-dispatch
  // abort and refunds the record; a provider failure after dispatch
  // does not refund.
  if (validated.tool.name === "web_search") {
    const args = validated.args as { query: string };
    const { data: recorded, error: recordError } = await clients.admin.rpc(
      "record_search",
      { p_user_id: userId },
    );
    if (recordError !== null) {
      console.error("Search record failed", recordError);
      try {
        await clients.admin.rpc("log_read_only_action", {
          p_user_id: userId,
          p_conversation_id: conversationId,
          p_tool_call_id: call.toolCallId,
          p_tool: call.toolName,
          p_params: toJson(validated.args),
          p_status: "failed",
          p_result: toJson({ error: "search_unavailable" }),
        });
      } catch (logErr) {
        console.error("Failed to log read-only action", logErr);
      }
      return {
        outcome: "tool_result",
        result: errorResult(call, { error: "search_unavailable" }),
        summary: "Called web_search. The search could not be recorded.",
      };
    }
    // record_search returns exactly one row; anything else means the
    // record did not happen, so the search is refused honestly.
    const recordedRow =
      recorded && recorded.length === 1
        ? (recorded[0] as { usage_date: string } | undefined)
        : undefined;
    if (!recordedRow) {
      return {
        outcome: "tool_result",
        result: errorResult(call, { error: "search_unavailable" }),
        summary: "Called web_search. The search could not be recorded.",
      };
    }
    const usageDate = recordedRow.usage_date;
    try {
      const output = await executeWebSearch(
        args.query,
        deps.searchProvider ?? searchTavily,
      );
      const outputJson = toJson(output);
      await clients.admin.rpc("log_read_only_action", {
        p_user_id: userId,
        p_conversation_id: conversationId,
        p_tool_call_id: call.toolCallId,
        p_tool: call.toolName,
        p_params: toJson(validated.args),
        p_status: "succeeded",
        p_result: outputJson,
      });
      return {
        outcome: "tool_result",
        result: {
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: "json", value: outputJson },
        },
        summary: `Called web_search for "${args.query}". Returned ${output.sources.length} result(s).`,
      };
    } catch (err) {
      // A pre-dispatch abort (the provider key is missing) refunds
      // the record: nothing was sent to the provider, so the
      // search did not happen. A provider failure after dispatch is
      // NOT refunded — the same rule as the model-call record.
      if (err instanceof TavilyError && err.code === "provider-misconfigured") {
        try {
          await clients.admin.rpc("refund_search", {
            p_user_id: userId,
            p_usage_date: usageDate,
          });
        } catch (refundErr) {
          console.error("Failed to refund search record", refundErr);
        }
      }
      try {
        await clients.admin.rpc("log_read_only_action", {
          p_user_id: userId,
          p_conversation_id: conversationId,
          p_tool_call_id: call.toolCallId,
          p_tool: call.toolName,
          p_params: toJson(validated.args),
          p_status: "failed",
          p_result: toJson({ error: "search_unavailable" }),
        });
      } catch (logErr) {
        console.error("Failed to log read-only action", logErr);
      }
      console.error("Web search failed", err);
      return {
        outcome: "tool_result",
        result: errorResult(call, { error: "search_unavailable" }),
        summary: "Called web_search. The search provider could not be reached.",
      };
    }
  }

  // Read-only: get_tasks is the only remaining read-only tool.
  try {
    const output = await executeGetTasks(
      clients.supabase,
      userId,
      validated.args as { status?: "pending" | "completed" },
    );
    const outputJson = toJson(output);
    await clients.admin.rpc("log_read_only_action", {
      p_user_id: userId,
      p_conversation_id: conversationId,
      p_tool_call_id: call.toolCallId,
      p_tool: call.toolName,
      p_params: toJson(validated.args),
      p_status: "succeeded",
      p_result: outputJson,
    });
    return {
      outcome: "tool_result",
      result: {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "json", value: outputJson },
      },
      summary: `Called get_tasks. Returned ${output.tasks.length} task(s).`,
    };
  } catch (err) {
    // The query failed: log the failure, then report it honestly.
    // The error result carries only the code — never the database
    // error, so no internals can leak to the model.
    try {
      await clients.admin.rpc("log_read_only_action", {
        p_user_id: userId,
        p_conversation_id: conversationId,
        p_tool_call_id: call.toolCallId,
        p_tool: call.toolName,
        p_params: toJson(validated.args),
        p_status: "failed",
        p_result: toJson({ error: "query_failed" }),
      });
    } catch (logErr) {
      console.error("Failed to log read-only action", logErr);
    }
    console.error("Read-only tool failed", err);
    return {
      outcome: "tool_result",
      result: errorResult(call, { error: "query_failed" }),
      summary: "Called get_tasks. The task list could not be loaded.",
    };
  }
}
