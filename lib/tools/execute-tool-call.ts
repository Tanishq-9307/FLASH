// One model tool call, executed server-side (M3-17).
//
// Plain language: the model never runs a tool itself — the loop
// hands each call here, and this decides what happens to it:
//   - unknown tool name, or arguments that fail the registry's Zod
//     schema → an error result goes back to the model, and nothing
//     runs. No log row either: nothing was executed, so there is no
//     action to audit (the tool-call message the loop persists still
//     records the attempt).
//   - state-changing tool (create_task, save_memory) → an
//     approval_required error result, and nothing runs. The approval
//     flow that replaces this branch is M3-18; until then the model
//     is told plainly that the action needs the owner's approval.
//   - read-only tool (get_tasks) → run the query with the
//     user-scoped client, log the outcome via log_read_only_action
//     (succeeded with the result, or failed with a generic error),
//     and return the result to the model. A query failure is reported
//     honestly as query_failed — never with database internals, and
//     never with invented tasks.
//
// The return is the tool-result part for the model's next message
// plus a one-line summary the loop persists as the message text.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolResultPart } from "ai";
import type { Database } from "@/types/supabase";
import { toJson } from "@/lib/json";
import { validateToolCall } from "./registry";
import { executeGetTasks } from "./read-only";

export interface ToolCallInput {
  toolCallId: string;
  toolName: string;
  /** The model's raw arguments (already parsed from JSON by the SDK). */
  input: unknown;
}

export interface ExecutedToolCall {
  /** The tool-result part for the model's next message. */
  result: ToolResultPart;
  /** One honest line about what happened, for the persisted message. */
  summary: string;
}

export interface ToolCallClients {
  /** User-scoped client: RLS proves ownership on every read. */
  supabase: SupabaseClient<Database>;
  /** Admin client (service role): only for the audit log. */
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

export async function executeToolCall(
  clients: ToolCallClients,
  userId: string,
  conversationId: string,
  call: ToolCallInput,
): Promise<ExecutedToolCall> {
  const validated = validateToolCall(call.toolName, call.input);
  if (!validated.ok) {
    return {
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
    // M3-18 replaces this branch with create_pending_approval. Until
    // then the model is told the action needs the owner's approval —
    // and nothing is executed.
    return {
      result: errorResult(call, {
        error: "approval_required",
        message: "This action needs the owner's approval first.",
      }),
      summary: `Proposed ${call.toolName} (approval required).`,
    };
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
      result: errorResult(call, { error: "query_failed" }),
      summary: "Called get_tasks. The task list could not be loaded.",
    };
  }
}
