// Telegram remote chat (Phase 3, 2026-11-25): messages sent to the bot
// go through the SAME pipeline as the web chat — same model (Groq with
// the OpenRouter hot-swap), same system prompt, same approved memories,
// same vector retrieval, same silent web research, same tool registry,
// same usage record, same approvals discipline. This is NOT a second
// chat brain: it reuses the web route's building blocks
// (lib/prompt, lib/memory-injection, lib/vector-retrieval,
// lib/search/silent-research, lib/ai/provider, lib/tools/*) and runs
// the same tool loop (at most 3 model calls, ARCHITECTURE.md §6).
//
// Differences from the web route, all forced by the channel:
//   - There is no browser session, so there is no getUser(): the
//     webhook already proved the sender is the owner (Telegram user-id
//     lock), and this function runs with the service-role admin client
//     for the owner's Supabase user id.
//   - The reply is plain text, not a stream: generateText (one step per
//     call) instead of streamText, and the final text is sent back over
//     the Telegram Bot API by the webhook route.
//   - History lives in one persistent "Telegram" conversation, so a
//     Telegram chat has the same continuity as a web conversation and
//     shows up in the web conversation list.
//   - A state-changing tool (create_task, save_memory) still only
//     PROPOSES: it becomes a pending approval exactly as on the web,
//     and the reply tells the owner to approve or reject it in the
//     FLASH web app — Telegram cannot approve actions.
import {
  convertToModelMessages,
  generateText,
  stepCountIs,
  type ModelMessage,
  type ToolResultPart,
} from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { chatModel, createFailoverState } from "@/lib/ai/provider";
import { MAX_MODEL_CALLS_PER_REQUEST, usageDateToday } from "@/lib/config";
import { SYSTEM_PROMPT } from "@/lib/prompt";
import { dbMessagesToUIMessages } from "@/lib/chat-history";
import { loadMemoryBlock } from "@/lib/memory-injection";
import { retrieveVectorContext } from "@/lib/vector-retrieval";
import { toJson } from "@/lib/json";
import { toModelTools } from "@/lib/tools/registry";
import { executeToolCall } from "@/lib/tools/execute-tool-call";
import {
  runSilentResearch,
  shouldResearch,
  type SilentResearchResult,
} from "@/lib/search/silent-research";

/** Title of the persistent conversation Telegram chats live in. */
export const TELEGRAM_CONVERSATION_TITLE = "Telegram";

export interface TelegramChatResult {
  /** The plain-text reply to send back over Telegram. */
  reply: string;
  /** The conversation the turn was filed under (null on early failure). */
  conversationId: string | null;
  /** Set when the turn proposed a state-changing action. */
  approvalId: string | null;
}

async function appendAssistantMessage(
  admin: SupabaseClient<Database>,
  userId: string,
  conversationId: string,
  role: "assistant" | "system",
  content: string,
  parts: unknown,
): Promise<void> {
  try {
    await admin.rpc("append_message", {
      p_user_id: userId,
      p_conversation_id: conversationId,
      p_role: role,
      p_content: content,
      p_parts: parts === null ? null : toJson(parts),
      p_tool_call_id: null,
    });
  } catch (err) {
    // The reply was already computed; a failed persist must not turn
    // the turn into an error.
    console.error("Telegram chat: failed to persist message", err);
  }
}

/** Run one Telegram message through the web chat pipeline and return
 * the plain-text reply. Never throws for a model or database failure:
 * those come back as an honest reply text instead, so the webhook can
 * still answer the owner (or log it) instead of crashing. */
export async function runTelegramChat(
  admin: SupabaseClient<Database>,
  userId: string,
  text: string,
): Promise<TelegramChatResult> {
  const today = usageDateToday();

  // Resolve or create the persistent Telegram conversation.
  let conversationId: string | null = null;
  try {
    const { data: existing, error: findError } = await admin
      .from("conversations")
      .select("id")
      .eq("user_id", userId)
      .eq("title", TELEGRAM_CONVERSATION_TITLE)
      .order("created_at", { ascending: false })
      .limit(1);
    if (findError) throw findError;
    if (existing && existing.length > 0) {
      conversationId = existing[0].id;
    } else {
      const { data: created, error: createError } = await admin
        .from("conversations")
        .insert({ title: TELEGRAM_CONVERSATION_TITLE, user_id: userId })
        .select("id")
        .single();
      if (createError || !created) throw createError ?? new Error("no row");
      conversationId = created.id;
    }
  } catch (err) {
    console.error("Telegram chat: conversation lookup failed", err);
    return {
      reply:
        "I couldn't open our chat history, so I can't reply right now. Try again in a bit.",
      conversationId: null,
      approvalId: null,
    };
  }

  // Store the user message before the gate (same rule as the web route:
  // the user did send it, so it is kept even if the model cannot reply).
  const { error: insertError } = await admin.from("messages").insert({
    conversation_id: conversationId,
    user_id: userId,
    role: "user",
    content: text,
  });
  if (insertError) {
    console.error("Telegram chat: user message insert failed", insertError);
    return {
      reply:
        "I couldn't save your message, so I can't reply right now. Try again in a bit.",
      conversationId,
      approvalId: null,
    };
  }

  async function recordModelCall(): Promise<"ok" | "unavailable"> {
    const { data, error } = await admin.rpc("record_api_call", {
      p_user_id: userId,
    });
    if (error) return "unavailable";
    if (!data || data.length === 0) return "unavailable";
    return "ok";
  }

  // Gate for the first call: a record failure fails closed — an
  // uncounted call would make the usage meter lie.
  if ((await recordModelCall()) === "unavailable") {
    return {
      reply:
        "The model-call usage could not be recorded, so I stopped before answering. Try again.",
      conversationId,
      approvalId: null,
    };
  }

  // Load the history from the database — the only history the model sees.
  const { data: rows, error: historyError } = await admin
    .from("messages")
    .select("id, role, content, parts, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (historyError || !rows) {
    console.error("Telegram chat: history load failed", historyError);
    return {
      reply:
        "I couldn't load our chat history, so I can't reply right now. Try again in a bit.",
      conversationId,
      approvalId: null,
    };
  }
  const history = dbMessagesToUIMessages(rows);

  // Approved memories (background about the owner, never instructions).
  // A failed load must not block the reply.
  let memoryBlock: string | null = null;
  try {
    memoryBlock = await loadMemoryBlock(admin, userId);
  } catch (err) {
    console.error("Telegram chat: memory load failed", err);
  }

  // Vector retrieval by meaning (same as the web route). Unavailable,
  // failed, or nothing similar enough means no block.
  let vectorBlock: string | null = null;
  try {
    const vector = await retrieveVectorContext(admin, userId, text, {
      memoryBlock,
    });
    vectorBlock = vector?.block ?? null;
  } catch (err) {
    console.error("Telegram chat: vector retrieval failed", err);
  }

  // Silent web research, same trigger and accounting as the web route.
  // A missing key, an empty result, or a provider failure means no
  // research — the turn continues without it, honestly.
  let research: Extract<SilentResearchResult, { status: "ok" }> | null =
    null;
  if (shouldResearch(text)) {
    try {
      const result = await runSilentResearch({
        admin,
        userId,
        conversationId,
        query: text,
      });
      if (result.status === "ok") research = result;
    } catch (err) {
      console.error("Telegram chat: silent research failed", err);
    }
  }

  const instructionParts = [SYSTEM_PROMPT];
  if (memoryBlock) instructionParts.push(memoryBlock);
  if (vectorBlock) instructionParts.push(vectorBlock);
  if (research) instructionParts.push(research.contextBlock);
  const instructions = instructionParts.join("\n\n");

  const modelMessages: ModelMessage[] =
    await convertToModelMessages(history);
  const failover = createFailoverState();

  async function persistToolStep(
    toolCallParts: Array<Record<string, unknown>>,
    toolResultParts: ToolResultPart[],
    summaries: string[],
  ): Promise<void> {
    await appendAssistantMessage(
      admin,
      userId,
      conversationId as string,
      "assistant",
      summaries.join("\n"),
      [...toolCallParts, ...toolResultParts],
    );
  }

  // Tool loop (same shape as the web route): at most
  // MAX_MODEL_CALLS_PER_REQUEST model calls, one step each.
  let callsMade = 0;
  for (;;) {
    if (callsMade > 0) {
      if (callsMade >= MAX_MODEL_CALLS_PER_REQUEST) {
        const notice =
          "Maximum reasoning depth reached. I stopped here instead of making another model call — send a new message to continue.";
        await appendAssistantMessage(
          admin,
          userId,
          conversationId,
          "system",
          notice,
          null,
        );
        return { reply: notice, conversationId, approvalId: null };
      }
      if ((await recordModelCall()) === "unavailable") {
        const notice =
          "The model-call usage could not be recorded, so the turn ended here. Try again.";
        await appendAssistantMessage(
          admin,
          userId,
          conversationId,
          "system",
          notice,
          null,
        );
        return { reply: notice, conversationId, approvalId: null };
      }
    }

    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
        model: chatModel(failover),
        instructions,
        messages: modelMessages,
        tools: toModelTools(),
        stopWhen: stepCountIs(1),
        maxRetries: 0,
        allowSystemInMessages: true,
      });
    } catch {
      // generateText threw before dispatch — the provider was never
      // called, so refund this call's record (same rule as the web
      // route: no dispatch, no charge).
      await admin.rpc("refund_api_call", {
        p_user_id: userId,
        p_usage_date: today,
      });
      return {
        reply: "The model could not be reached. Try again.",
        conversationId,
        approvalId: null,
      };
    }
    callsMade += 1;

    if (!result.toolCalls || result.toolCalls.length === 0) {
      const reply =
        result.text.trim() !== ""
          ? result.text
          : "I don't have a reply for that — try rephrasing it.";
      await appendAssistantMessage(
        admin,
        userId,
        conversationId,
        "assistant",
        reply,
        null,
      );
      return { reply, conversationId, approvalId: null };
    }

    // Execute this step's tool calls server-side, in order.
    const toolResults: ToolResultPart[] = [];
    const summaries: string[] = [];
    let createdApprovalId: string | null = null;
    for (const call of result.toolCalls) {
      const executed = await executeToolCall(
        { supabase: admin, admin },
        userId,
        conversationId,
        {
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
        },
      );
      summaries.push(executed.summary);
      if (executed.outcome === "approval_created") {
        if (createdApprovalId === null) {
          createdApprovalId = executed.approvalId;
        }
        // No tool-result part: the turn ends and the model never sees one.
      } else {
        toolResults.push(executed.result);
      }
    }

    await persistToolStep(
      result.toolCalls.map((call) => ({
        type: "tool-call",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
      })),
      toolResults,
      summaries,
    );

    if (createdApprovalId !== null) {
      const reply =
        `${summaries.join("\n")}\nApprove or reject it in the FLASH web app — I can't approve actions from Telegram.`;
      await appendAssistantMessage(
        admin,
        userId,
        conversationId,
        "assistant",
        reply,
        null,
      );
      return { reply, conversationId, approvalId: createdApprovalId };
    }

    modelMessages.push({
      role: "assistant",
      content: result.toolCalls.map((call) => ({
        type: "tool-call",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
      })),
    });
    modelMessages.push({ role: "tool", content: toolResults });
  }
}
