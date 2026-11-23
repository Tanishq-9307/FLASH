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
//   - read-only tool (get_tasks) → run the query with the
//     user-scoped client, log the outcome via log_read_only_action
//     (succeeded with the result, or failed with a generic error),
//     and return the result to the model. A query failure is reported
//     honestly as query_failed — never with database internals, and
//     never with invented tasks.
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
import { validateToolCall } from "./registry";
import { executeGetTasks } from "./read-only";

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
  const fact = String(args.fact ?? "");
  const shown = fact.length > 200 ? `${fact.slice(0, 200)}…` : fact;
  return `Proposed saving a memory: "${shown}". Waiting for your approval.`;
}

export async function executeToolCall(
  clients: ToolCallClients,
  userId: string,
  conversationId: string,
  call: ToolCallInput,
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
          p_params: toJson(validated.args),
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
          summary: proposalSummary(
            call.toolName,
            validated.args as Record<string, unknown>,
          ),
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

  // Read-only: get_tasks is the only read-only tool in the registry.
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
