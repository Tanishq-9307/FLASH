// POST /api/chat (M2-6): server-authoritative chat history.
//
// The browser sends only the new message (or a regenerate request) and a
// conversation ID. It never sends past messages: history comes from the
// database, so a client cannot forge, drop, or reorder turns, and cannot
// plant a fake assistant or tool message the model would then believe.
//
// Order of operations — the Model Gate (ARCHITECTURE.md §6):
// 1. Validate the body with Zod (unknown fields are stripped, so a forged
//    `messages` array in the body is ignored).
// 2. Verify the session with getUser(). Unauthenticated → 401, and nothing
//    is reserved.
// 3. Resolve the conversation with the user-scoped client (RLS: another
//    user's conversation looks like it does not exist → 404). If none was
//    given, create one, titled with the first ~60 characters of the first
//    message (no model call). For a regenerate, the last stored message
//    must be from the user.
// 4. Insert the new user message with the user-scoped client, before the
//    gate: the user did send it, so it is kept even if the cap is reached
//    and the model cannot reply yet (the user can regenerate later).
// 4b. If a documentId was given (M5-4), load the document with the
//    user-scoped client (RLS: another user's document looks like it does
//    not exist → 404; a document that is not 'ready' → 400). This happens
//    before the reserve, so a bad document costs no model call.
// 5. Reserve one model call with reserve_api_call (cap from server config).
//    If it returns no row the cap is reached → explicit 429 the UI can
//    render, and no model call is made. If the reservation itself errors,
//    the gate fails closed with 503. This is the gate for the first call;
//    every later call in the loop is gated the same way (step 7), except
//    a mid-loop cap ends the turn with a system message instead of a 429,
//    because the stream has already started.
// 6. If the request was aborted before dispatch, refund the reservation
//    and answer 499 (client closed request). This is the only refund path:
//    once the model call is dispatched, a timeout, a dropped connection, or
//    a provider error is never refunded — the provider may already have
//    used quota. (A document retrieval failure below also refunds: the
//    model was never called, so the call was never dispatched.)
// 7. Load the history from the database (including the message just
//    inserted) and run the tool loop (M3-17): at most 3 model calls, each
//    gated (depth check, then reserve_api_call) and each a single step
//    (stopWhen: stepCountIs(1)). After a step with tool calls, the server
//    executes them — invalid arguments get an error result and nothing
//    runs; read-only tools run with the user-scoped client and are logged
//    via log_read_only_action; state-changing tools are recorded as
//    proposals with create_pending_approval (M3-18) and never executed
//    — the loop then ends the stream with a data part carrying only
//    the approval_id, and the owner decides in the approval dialog
//    (M3-21). If an approval is already open, the proposal is
//    discarded and the model gets an error result instead. Then the
//    results go back to the model for the next step. A step with
//    no tool calls is the final answer and ends the loop. If the model
//    still wants tools after the third call, the loop appends a "Maximum
//    reasoning depth reached" system message and ends the turn. For a
//    document question, the relevant pages are retrieved first (full-text
//    search over document_pages for the user's question) and enter the
//    prompt inside a delimited untrusted-data block; the answer must cite
//    them as [p. N] or say the document does not say.
// 8. Persist the assistant reply with append_message (service role) when
//    the stream ends. A complete reply is stored plain; an aborted stream
//    stores the partial text with an incomplete marker in `parts`, and the
//    UI shows "Reply interrupted". A provider error stores nothing — the
//    user message stays and Retry/regenerate handles it. Tool steps are
//    persisted as one assistant message per step, with the tool-call and
//    tool-result parts in `parts` and a one-line summary as the text, so
//    a refresh shows what happened; the full parts stay in the database
//    for the activity timeline (M3-22). For a document question, the
//    reply's citations are verified against the retrieved pages; an
//    unverified reply gets a system note saying so, instead of being
//    presented as sourced.
//
// The conversation ID reaches the client as a data part at the start of
// the stream, so the client can move to /chat?id=<id> when the stream
// finishes and a refresh reloads the conversation from the database.
//
// Depth: at most 3 model calls per request (ARCHITECTURE.md §6). The
// counter resets on each new user message or regenerate request.
import { NextResponse } from "next/server";
import { google } from "@ai-sdk/google";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type ModelMessage,
  type ToolResultPart,
} from "ai";
import { z } from "zod";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { modelCallCap, usageDateToday, MAX_MODEL_CALLS_PER_REQUEST } from "@/lib/config";
import { SYSTEM_PROMPT } from "@/lib/prompt";
import { dbMessagesToUIMessages, uiMessageText } from "@/lib/chat-history";
import {
  searchDocumentPages,
  type RetrievedPage,
} from "@/lib/documents/retrieve";
import { verifyAnswerCitations } from "@/lib/documents/citations";
import { buildDocumentPrompt } from "@/lib/documents/document-prompt";
import { loadMemoryBlock } from "@/lib/memory-injection";
import { toJson } from "@/lib/json";
import { toModelTools } from "@/lib/tools/registry";
import { executeToolCall } from "@/lib/tools/execute-tool-call";

export const maxDuration = 60;

const textPartSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1).max(8000),
});

const messageSchema = z.object({
  id: z.string().min(1),
  role: z.literal("user"),
  parts: z.array(textPartSchema).min(1).max(1),
});

const bodySchema = z
  .object({
    conversationId: z.string().uuid().nullish(),
    message: messageSchema.optional(),
    regenerate: z.boolean().optional(),
    // M5-4: ask about one of the owner's documents. The document's pages
    // are retrieved server-side and enter the prompt as untrusted data;
    // the client never sends page text.
    documentId: z.string().uuid().optional(),
  })
  .refine((b) => Boolean(b.message) !== Boolean(b.regenerate), {
    message: "send exactly one of message or regenerate",
  })
  .refine((b) => !b.regenerate || Boolean(b.conversationId), {
    message: "regenerate needs a conversationId",
  });

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const {
    conversationId: requestedId,
    message,
    regenerate,
    documentId,
  } = parsed.data;

  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  // Captured once: the helpers below are closures, and TypeScript does
  // not carry the narrowing of the destructured `user` into them.
  const userId = user.id;

  // Resolve or create the conversation (user-scoped client: RLS proves
  // ownership, and another user's conversation looks like it is absent).
  let conversationId: string;
  if (requestedId) {
    const { data: conv, error: convError } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", requestedId)
      .single();
    if (convError || !conv) {
      return NextResponse.json(
        { error: "conversation_not_found" },
        { status: 404 },
      );
    }
    conversationId = conv.id;
  } else {
    // No conversation yet: create one from the first message (regenerate
    // without an ID was already rejected by validation, so message exists).
    const firstText = message!.parts[0].text.trim().slice(0, 60) || "New chat";
    const { data: conv, error: createError } = await supabase
      .from("conversations")
      .insert({ title: firstText })
      .select("id")
      .single();
    if (createError || !conv) {
      return NextResponse.json(
        { error: "conversation_create_failed" },
        { status: 500 },
      );
    }
    conversationId = conv.id;
  }

  // Store the new user message before the gate (see header, step 4).
  if (message) {
    const { error: insertError } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "user",
      content: message.parts[0].text,
    });
    if (insertError) {
      return NextResponse.json(
        { error: "message_insert_failed" },
        { status: 500 },
      );
    }
  }

  // A document question names the document; its pages are retrieved
  // server-side, so validate it before the reserve — a bad document costs
  // no model call. RLS makes another user's document look absent.
  let documentTitle: string | null = null;
  if (documentId) {
    const { data: doc, error: docError } = await supabase
      .from("documents")
      .select("id, title, status")
      .eq("id", documentId)
      .single();
    if (docError || !doc) {
      return NextResponse.json(
        { error: "document_not_found" },
        { status: 404 },
      );
    }
    if (doc.status !== "ready") {
      return NextResponse.json(
        { error: "document_not_ready" },
        { status: 400 },
      );
    }
    documentTitle = doc.title;
  }

  const admin = createAdminClient();
  const cap = modelCallCap();
  const today = usageDateToday();

  // One Model Gate reservation (ARCHITECTURE.md §6): reserve_api_call
  // before dispatch. "capped" means the daily cap is reached (no row);
  // "unavailable" means the reservation itself errored and the gate
  // fails closed. Used for the first call below, and for every later
  // call inside the loop.
  async function reserveModelCall(): Promise<"ok" | "capped" | "unavailable"> {
    const { data, error } = await admin.rpc("reserve_api_call", {
      p_user_id: userId,
      p_cap: cap,
    });
    if (error) return "unavailable";
    if (!data || data.length === 0) return "capped";
    return "ok";
  }

  // Gate for the first call: before the stream starts, so a cap can
  // still be answered with a plain 429 and a gate error with a 503.
  const firstGate = await reserveModelCall();
  if (firstGate === "unavailable") {
    return NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 });
  }
  if (firstGate === "capped") {
    return NextResponse.json(
      {
        error: "cap_reached",
        usage: cap,
        cap,
        message: `Daily limit reached. You have used ${cap} of ${cap} model calls today. Try again tomorrow.`,
      },
      { status: 429 },
    );
  }

  if (request.signal.aborted) {
    await admin.rpc("refund_api_call", { p_user_id: user.id, p_usage_date: today });
    return NextResponse.json({ error: "request_aborted" }, { status: 499 });
  }

  // Load the history from the database — the only history the model sees.
  const { data: rows, error: historyError } = await supabase
    .from("messages")
    .select("id, role, content, parts, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (historyError || !rows) {
    return NextResponse.json({ error: "history_load_failed" }, { status: 500 });
  }
  const history = dbMessagesToUIMessages(rows);

  if (regenerate) {
    const last = history[history.length - 1];
    if (!last || last.role !== "user") {
      return NextResponse.json(
        { error: "cannot_regenerate", message: "The last message is not from you." },
        { status: 400 },
      );
    }
  }

  // Retrieve the document's relevant pages for the question (M5-4). The
  // question is the new message, or the last user message on a regenerate.
  // A retrieval failure is before dispatch: refund and fail closed.
  let documentPages: RetrievedPage[] = [];
  let documentContext: string | null = null;
  if (documentId && documentTitle !== null) {
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    const queryText = message
      ? message.parts[0].text
      : lastUser
        ? uiMessageText(lastUser)
        : "";
    try {
      documentPages = await searchDocumentPages(
        supabase,
        user.id,
        documentId,
        queryText,
      );
    } catch (err) {
      await admin.rpc("refund_api_call", {
        p_user_id: user.id,
        p_usage_date: today,
      });
      console.error("Document search failed", err);
      return NextResponse.json(
        { error: "document_search_unavailable" },
        { status: 503 },
      );
    }
    documentContext = buildDocumentPrompt(documentTitle, documentPages);
  }

  // Approved memories, as a delimited block of user data (M3-16).
  // A failed load must not block the reply: memories are background
  // about the owner, not the answer itself. Log it and continue
  // without the block — the model still answers the question.
  let memoryBlock: string | null = null;
  try {
    memoryBlock = await loadMemoryBlock(supabase, user.id);
  } catch (err) {
    console.error("Memory load failed", err);
  }

  const instructionParts = [SYSTEM_PROMPT];
  if (memoryBlock) instructionParts.push(memoryBlock);
  if (documentContext) instructionParts.push(documentContext);
  const instructions = instructionParts.join("\n\n");

  // The model messages for the loop: history first, then each step's
  // assistant tool-call message and the tool-result message appended
  // after the server executes the calls.
  const modelMessages: ModelMessage[] =
    await convertToModelMessages(history);

  // Persist a system notice (depth overrun, mid-loop cap). The notice
  // is the record the user sees on refresh; the stream simply ends
  // after it. A failed persist is logged, never fatal.
  async function appendSystemNotice(text: string): Promise<void> {
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
      console.error("Failed to persist system notice", err);
    }
  }

  // Persist one assistant message for a tool step: the tool-call parts
  // and the tool-result parts, with a one-line summary as the text.
  // The history loader renders the summary as text on refresh, and
  // the full parts stay in the database for the activity timeline
  // (M3-22). A failed persist is logged, never fatal — the results
  // were already handed to the model for the next step.
  async function persistToolStep(
    toolCallParts: Array<Record<string, unknown>>,
    toolResultParts: ToolResultPart[],
    summaries: string[],
  ): Promise<void> {
    try {
      await admin.rpc("append_message", {
        p_user_id: userId,
        p_conversation_id: conversationId,
        p_role: "assistant",
        p_content: summaries.join("\n"),
        p_parts: toJson([...toolCallParts, ...toolResultParts]),
        p_tool_call_id:
          (toolCallParts[0]?.toolCallId as string | undefined) ?? null,
      });
    } catch (err) {
      console.error("Failed to persist tool message", err);
    }
  }

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // The client learns the conversation ID first, so it can move to
      // /chat?id=<id> when the stream finishes.
      writer.write({
        type: "data-conversation",
        data: { conversationId },
      });

      // Tool loop (M3-17): at most MAX_MODEL_CALLS_PER_REQUEST model
      // calls. Each call is one step (stopWhen: stepCountIs(1)) and is
      // gated before dispatch — the first call was gated above, later
      // calls are gated at the top of the loop. A step with no tool
      // calls is the final answer and ends the loop.
      let callsMade = 0;
      for (;;) {
        // Model Gate for calls 2 and 3 (ARCHITECTURE.md §6): depth
        // check, then reserve. A fourth call is refused here — the
        // third call's tool results were already executed and
        // persisted, but the model never sees them; the system message
        // says why no answer followed.
        if (callsMade > 0) {
          if (callsMade >= MAX_MODEL_CALLS_PER_REQUEST) {
            await appendSystemNotice(
              "Maximum reasoning depth reached. I stopped here instead of making another model call — send a new message to continue.",
            );
            break;
          }
          const gate = await reserveModelCall();
          if (gate === "capped") {
            await appendSystemNotice(
              `Daily model-call limit reached (${cap} of ${cap} used). The turn ended here — try again tomorrow.`,
            );
            break;
          }
          if (gate === "unavailable") {
            await appendSystemNotice(
              "The daily model-call limit could not be checked, so the turn ended here. Try again.",
            );
            break;
          }
        }

        let result: ReturnType<typeof streamText>;
        try {
          result = streamText({
            model: google("gemini-3.8-flash"),
            instructions,
            messages: modelMessages,
            tools: toModelTools(),
            stopWhen: stepCountIs(1),
            abortSignal: request.signal,
          });
        } catch {
          // streamText threw before dispatch — the provider was never
          // called. The first call's reservation was already refunded
          // by the caller below; a later call's reservation is
          // refunded here for the same reason (no dispatch happened).
          await admin.rpc("refund_api_call", {
            p_user_id: user.id,
            p_usage_date: today,
          });
          await appendSystemNotice(
            "The model could not be reached. Try again.",
          );
          break;
        }

        // Stream this step's reply (text and tool activity) to the
        // client. onEnd persists a text reply when the step produced
        // one; a pure tool step has no text, so nothing is persisted
        // here — the loop persists its tool message below instead.
        writer.merge(
          toUIMessageStream({
            stream: result.stream,
            onEnd: async ({ isAborted, isCancelled, outcome, responseMessage }) => {
              // Provider error: persist nothing (M1 behaviour). The user
              // message stays; Retry/regenerate handles it.
              if (outcome.status === "failed") return;
              const aborted =
                isAborted || isCancelled === true || outcome.status !== "completed";
              const text = uiMessageText(responseMessage);
              if (!text) return;
              try {
                await admin.rpc("append_message", {
                  p_user_id: user.id,
                  p_conversation_id: conversationId,
                  p_role: "assistant",
                  p_content: text,
                  p_parts: aborted ? { incomplete: true } : null,
                  p_tool_call_id: null,
                });
              } catch (err) {
                // The reply was already streamed to the user; a failed
                // persist must not turn the response into an error.
                console.error("Failed to persist assistant reply", err);
              }
              // Document questions (M5-4): verify the reply's citations
              // against the pages the model was shown. A reply that declines
              // needs no citations; a reply whose citations cannot be
              // verified gets a system note saying so, instead of being
              // presented as sourced. Only for completed replies — an
              // interrupted reply is already marked incomplete.
              if (!aborted && documentId && documentContext !== null) {
                const verification = verifyAnswerCitations(text, documentPages);
                if (verification.status === "unverified") {
                  try {
                    await admin.rpc("append_message", {
                      p_user_id: user.id,
                      p_conversation_id: conversationId,
                      p_role: "system",
                      p_content:
                        "Note: this reply's citations could not be verified against the stored document pages.",
                      p_parts: null,
                      p_tool_call_id: null,
                    });
                  } catch (err) {
                    console.error("Failed to persist citation note", err);
                  }
                }
              }
            },
          }),
        );

        // Wait for the step to finish, then read what the model did.
        // (awaiting steps consumes nothing extra — the merge above
        // drives the stream; steps resolves when it completes.)
        const steps = await result.steps;
        callsMade += 1;
        const step = steps[0];
        if (!step || step.toolCalls.length === 0) break;

        // Execute this step's tool calls server-side, one at a time,
        // in the order the model made them.
        const toolResults: ToolResultPart[] = [];
        const summaries: string[] = [];
        // A proposal ends the stream: the first approval created in
        // this step is the one the client opens a dialog for. Every
        // call in the step is still processed in order first, so a
        // second proposal in the same step hits open_approval_exists
        // and is discarded (its error result is persisted but never
        // reaches the model — the stream has ended).
        let createdApprovalId: string | null = null;
        for (const call of step.toolCalls) {
          const executed = await executeToolCall(
            { supabase, admin },
            user.id,
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
            // No tool-result part: the stream ends and the model never
            // sees one.
          } else {
            toolResults.push(executed.result);
          }
        }

        // Persist the step (call + result parts) and hand the results
        // to the model for the next step. The assistant message carries
        // only the tool-call parts — any text the step also produced
        // was already persisted separately by onEnd above, so it must
        // not appear twice in the history. For a proposal the parts
        // are the tool-call parts only (no result part exists), and
        // the message text is the proposal summary.
        await persistToolStep(
          step.toolCalls.map((call) => ({
            type: "tool-call",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: call.input,
          })),
          toolResults,
          summaries,
        );
        if (createdApprovalId !== null) {
          // M3-18: end the stream with a data part carrying only the
          // approval id. The dialog the owner sees (M3-21) renders
          // the parameters from the stored database snapshot as plain
          // text — never from the model, and never from this stream.
          writer.write({
            type: "data-approval",
            data: { approvalId: createdApprovalId },
          });
          break;
        }
        modelMessages.push({
          role: "assistant",
          content: step.toolCalls.map((call) => ({
            type: "tool-call",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: call.input,
          })),
        });
        modelMessages.push({ role: "tool", content: toolResults });
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
