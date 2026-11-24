// POST /api/chat/resume (M3-20): deliver an approval outcome to the
// model exactly once, honestly.
//
// The browser sends only the approval_id — never outcome text. The
// outcome comes from the database: the approval's status and the
// settled action-log row. That way a tampered client cannot invent
// an outcome, and the model reports only what really happened.
//
// Order of operations (ARCHITECTURE.md §7, Diagram 11.3):
// 1. Validate the body with Zod (approval_id plus the optional
//    codingMode flag, same flag as the chat route).
// 2. Verify the session with getUser(). Unauthenticated → 401.
// 3. expire_stale_approval (service role) — a no-op unless the
//    approval is overdue. This runs first so an overdue approval is
//    settled before the outcome is read.
// 4. mark_outcome_delivered (service role) — it stamps the outcome
//    only for final states and only once. No row means not final
//    yet, already delivered, or not owned: 200 and nothing to do.
//    This runs BEFORE the Model Gate, so a duplicate resume burns
//    no model call.
// 5. Read the real outcome from the approval row and the earliest
//    action-log row (user-scoped reads, so ownership is proven again).
//    The earliest log row is the one create_pending_approval wrote
//    and the approval functions settled; audit rows from
//    record_claim_failure are added later, so created_at order picks
//    the settled outcome.
// 6. Record the model call (record_api_call). If the record itself
//    errors, the outcome is still delivered: the route persists an
//    honest system message built from the actual state and returns it
//    as JSON. A record error is treated as a gate refusal rather than
//    a 503, because the outcome was already claimed for delivery in
//    step 4 and must not be silently dropped. There is no cap refusal
//    any more (owner decision 2026-11-24).
// 7. Build the follow-up from the database outcome and stream it
//    (one model call, no tools — a report, not a new turn), then
//    persist the reply with append_message. If the model call fails
//    before dispatch, the record is refunded and the system
//    notice path of step 6 runs instead; if the stream fails
//    mid-way, the system notice is persisted in onEnd and the client
//    sees the partial stream plus the notice on refresh.
import { NextResponse } from "next/server";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
} from "ai";
import { z } from "zod";
import { chatModel, createFailoverState, modelIdFor } from "@/lib/ai/provider";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { usageDateToday } from "@/lib/config";
import {
  dbMessagesToUIMessages,
  uiMessageText,
} from "@/lib/chat-history";

const resumeBodySchema = z.object({
  approval_id: z.string().uuid(),
  // Coding mode, same flag as the chat route: the follow-up runs the
  // larger Groq model when on, the default 70B when off or absent.
  codingMode: z.boolean().optional(),
});

export type ResumeOutcome =
  | "succeeded"
  | "failed"
  | "rejected"
  | "expired"
  | "unknown";

/** The outcome, from the approval status and the settled log row.
 * A 'failed' approval with a 'not_executed' log is a tamper close
 * (M3-12 settles the log as not_executed when it fails the approval);
 * a 'failed' log is three execution failures. */
function outcomeFromState(
  approvalStatus: string,
  logStatus: string,
): ResumeOutcome {
  if (logStatus === "unknown") return "unknown";
  switch (approvalStatus) {
    case "consumed":
      return "succeeded";
    case "rejected":
      return "rejected";
    case "expired":
      return "expired";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

/** The task's title from the stored parameters, or null. */
function storedTaskTitle(params: unknown): string | null {
  const title = (params as Record<string, unknown> | null)?.title;
  return typeof title === "string" && title !== "" ? title : null;
}

/** One honest sentence about what happened, built only from the
 * database state. The model is told to report only this. */
function outcomeSentence(
  outcome: ResumeOutcome,
  logStatus: string,
  toolName: string,
  params: unknown,
): string {
  const title = storedTaskTitle(params);
  const task = title === null ? "task" : `task "${title}"`;
  switch (outcome) {
    case "succeeded":
      return toolName === "create_task"
        ? `The ${task} was created.`
        : "The memory was saved.";
    case "failed":
      if (logStatus === "not_executed") {
        return `The proposed action could not be executed — the stored parameters did not match what was approved, so the approval was closed as a possible tamper event.`;
      }
      return toolName === "create_task"
        ? `The ${task} could not be created — the action failed three times and the approval is now closed.`
        : "The memory could not be saved — the action failed three times and the approval is now closed.";
    case "rejected":
      return toolName === "create_task"
        ? `The proposed ${task} was rejected and was not created.`
        : "The proposed memory was rejected and was not saved.";
    case "expired":
      return toolName === "create_task"
        ? `The proposed ${task} expired before it was decided and was not created.`
        : "The proposed memory expired before it was decided and was not saved.";
    case "unknown":
      return toolName === "create_task"
        ? `The ${task} was attempted, but the outcome is unverified — please check whether it was created before retrying.`
        : "The memory was attempted, but the outcome is unverified — please check whether it was saved before retrying.";
  }
}

export async function POST(request: Request) {
  const parsed = resumeBodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const approvalId = parsed.data.approval_id;
  // Default off: an absent flag is a normal follow-up.
  const codingMode = parsed.data.codingMode === true;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  // Capture the id right after the guard: TypeScript does not carry
  // the narrowing of the destructured `user` into the nested helper
  // closures below (same trap as the chat route).
  const userId = user.id;
  const admin = createAdminClient();

  // Expire an overdue approval first, so the outcome read below sees
  // the settled state.
  await admin.rpc("expire_stale_approval", {
    p_user_id: userId,
    p_approval_id: approvalId,
  });

  // Claim the outcome for delivery: final states only, once only.
  const { data: marked, error: markError } = await admin.rpc(
    "mark_outcome_delivered",
    { p_user_id: userId, p_approval_id: approvalId },
  );
  if (markError !== null) {
    console.error("mark_outcome_delivered failed", markError);
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
  if (marked === null || marked.length !== 1) {
    // Not final yet, already delivered, or not owned: nothing to do.
    return NextResponse.json({ outcome: "none" });
  }

  // Read the real outcome from the database (user-scoped reads).
  const { data: approval, error: approvalError } = await supabase
    .from("tool_approvals")
    .select("id, conversation_id, tool_name, status, parameters")
    .eq("id", approvalId)
    .single();
  if (approvalError !== null || approval === null) {
    console.error("resume: approval read failed", approvalError);
    return NextResponse.json(
      { error: "outcome_read_failed" },
      { status: 500 },
    );
  }
  const { data: logs, error: logsError } = await supabase
    .from("action_logs")
    .select("execution_status, result_payload")
    .eq("approval_id", approvalId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1);
  if (logsError !== null || logs === null || logs.length !== 1) {
    console.error("resume: action log read failed", logsError);
    return NextResponse.json(
      { error: "outcome_read_failed" },
      { status: 500 },
    );
  }
  const logStatus = logs[0].execution_status;
  const outcome = outcomeFromState(approval.status, logStatus);
  const sentence = outcomeSentence(
    outcome,
    logStatus,
    approval.tool_name,
    approval.parameters,
  );
  const conversationId = approval.conversation_id;

  async function persistSystemNotice(text: string): Promise<void> {
    try {
      await admin.rpc("append_message", {
        p_user_id: userId,
        p_conversation_id: conversationId,
        p_role: "system",
        p_content: text,
        p_parts: null,
        p_tool_call_id: null,
      });
    } catch (err) {
      // The notice was already returned to the browser in the JSON
      // response; a failed persist must not turn it into an error.
      // The tool message in history still carries the outcome.
      console.error("Failed to persist resume system notice", err);
    }
  }

  // Model Gate: one record for the single follow-up call.
  const today = usageDateToday();
  const recorded = await admin.rpc("record_api_call", {
    p_user_id: userId,
  });
  if (recorded.error !== null || recorded.data === null || recorded.data.length !== 1) {
    const notice = `${sentence} The model-call usage could not be recorded, so no model reply is available.`;
    await persistSystemNotice(notice);
    return NextResponse.json({ outcome, notice });
  }

  // Load the history from the database — the only history the model sees.
  const { data: rows, error: historyError } = await supabase
    .from("messages")
    .select("id, role, content, parts, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (historyError || !rows) {
    await admin.rpc("refund_api_call", {
      p_user_id: userId,
      p_usage_date: today,
    });
    const notice = `${sentence} The conversation history could not be loaded, so no model reply is available.`;
    await persistSystemNotice(notice);
    return NextResponse.json({ outcome, notice });
  }
  const history = dbMessagesToUIMessages(rows);
  const modelMessages = await convertToModelMessages(history);

  const instructions = [
    "You are FLASH, a personal assistant. The owner just decided on a proposed action.",
    "Report ONLY the outcome below, in one or two plain sentences. Do not invent details, do not claim anything else happened, and do not ask a follow-up question unless the outcome needs one.",
    `Outcome: ${sentence}`,
  ].join(" ");

  let result: ReturnType<typeof streamText>;
  // One backup attempt for this request; the next request starts on
  // Groq again. maxRetries 0: the hot-swap inside chatModel is the
  // only retry (see the chat route).
  const failover = createFailoverState();
  try {
    result = streamText({
      model: chatModel(failover, codingMode),
      instructions,
      messages: modelMessages,
      abortSignal: request.signal,
      maxRetries: 0,
      // The history can contain system messages (the tool outcome,
      // rendered as system by dbMessagesToUIMessages). They are
      // written by this server into the database — trusted, never
      // client-supplied — so the SDK's opt-in for system messages in
      // `messages` is safe here. Without it, the follow-up call throws
      // InvalidPromptError whenever an approval has reached a final
      // state.
      allowSystemInMessages: true,
    });
  } catch {
    // streamText threw before dispatch — the provider was never
    // called, so the record is refunded and the outcome is
    // delivered as a system notice instead.
    await admin.rpc("refund_api_call", {
      p_user_id: userId,
      p_usage_date: today,
    });
    const notice = `${sentence} The model reply failed, so this is the outcome as recorded.`;
    await persistSystemNotice(notice);
    return NextResponse.json({ outcome, notice });
  }

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // The model this follow-up actually runs on (same source as
      // the chat route), so the header never shows a model that was
      // not used.
      writer.write({
        type: "data-model",
        data: { modelId: modelIdFor(codingMode) },
      });
      writer.merge(
        result.toUIMessageStream({
          onEnd: async ({ isAborted, isCancelled, outcome: streamOutcome, responseMessage }) => {
            if (streamOutcome.status === "failed") {
              // Provider error mid-stream: the follow-up never
              // arrived, so the outcome is delivered as a system
              // notice instead. The partial reply is not persisted.
              const notice = `${sentence} The model reply failed, so this is the outcome as recorded.`;
              await persistSystemNotice(notice);
              return;
            }
            const aborted =
              isAborted || isCancelled === true || streamOutcome.status !== "completed";
            const text = uiMessageText(responseMessage);
            if (!text) return;
            try {
              await admin.rpc("append_message", {
                p_user_id: userId,
                p_conversation_id: conversationId,
                p_role: "assistant",
                p_content: text,
                p_parts: aborted ? { incomplete: true } : null,
                p_tool_call_id: null,
              });
            } catch (err) {
              // The reply was already streamed to the user; a failed
              // persist must not turn the response into an error.
              console.error("Failed to persist resume follow-up", err);
            }
          },
        }),
      );
    },
    onError: (error) => {
      console.error("Resume stream error", error);
      return "The model reply failed.";
    },
  });

  return createUIMessageStreamResponse({ stream });
}
