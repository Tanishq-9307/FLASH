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
//    is recorded.
// 3. Resolve the conversation with the user-scoped client (RLS: another
//    user's conversation looks like it does not exist → 404). If none was
//    given, create one, titled with the first ~60 characters of the first
//    message (no model call). For a regenerate, the last stored message
//    must be from the user.
// 4. Insert the new user message with the user-scoped client, before the
//    gate: the user did send it, so it is kept even if the usage record
//    fails and the model cannot reply yet (the user can regenerate later).
// 4b. If a documentId was given (M5-4), load the document with the
//    user-scoped client (RLS: another user's document looks like it does
//    not exist → 404; a document that is not 'ready' → 400). This happens
//    before the record, so a bad document costs no model call.
// 5. Record one model call with record_api_call (owner decision
//    2026-11-24: the daily cap is a display limit only — there is no
//    429 any more, chat is never blocked at an app-level cap; the
//    provider's own daily limit is the real ceiling). If the record
//    itself errors, the gate fails closed with 503: an uncounted call
//    would make the usage meter lie. This is the gate for the first
//    call; every later call in the loop is recorded the same way
//    (step 7).
// 6. If the request was aborted before dispatch, refund the record
//    and answer 499 (client closed request). This is the only refund path:
//    once the model call is dispatched, a timeout, a dropped connection, or
//    a provider error is never refunded — the provider may already have
//    used quota. (A document retrieval failure below also refunds: the
//    model was never called, so the call was never dispatched.)
// 7. Load the history from the database (including the message just
//    inserted) and run the tool loop (M3-17): at most 3 model calls, each
//    recorded (depth check, then record_api_call) and each a single step
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
import { chatModel, createFailoverState, modelIdFor } from "@/lib/ai/provider";
import { usageDateToday, MAX_MODEL_CALLS_PER_REQUEST } from "@/lib/config";
import { resolveCodingMode } from "@/lib/settings";
import { SYSTEM_PROMPT } from "@/lib/prompt";
import { dbMessagesToUIMessages, uiMessageText } from "@/lib/chat-history";
import {
  searchDocumentPages,
  type RetrievedPage,
} from "@/lib/documents/retrieve";
import { verifyAnswerCitations } from "@/lib/documents/citations";
import { buildDocumentPrompt } from "@/lib/documents/document-prompt";
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
    // Coding mode: the chat runs the larger Groq model
    // (openai/gpt-oss-120b) instead of the default 70B. Per-session
    // client state, default off — the client sends it with every
    // request (message and regenerate alike).
    codingMode: z.boolean().optional(),
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
    codingMode: codingModeFlag,
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

  // Coding mode (Phase 2, live configuration): an explicit per-request
  // flag always wins; when the request carries none, the owner's saved
  // default (settings.default_coding_mode) decides. A missing settings
  // row means off, and a failed read fails closed to off — the default
  // model is always safe to fall back to.
  let codingMode = codingModeFlag === true;
  if (codingModeFlag === undefined) {
    const { data: settingsRow } = await supabase
      .from("settings")
      .select("default_coding_mode")
      .eq("user_id", userId)
      .single();
    codingMode = resolveCodingMode(
      undefined,
      settingsRow?.default_coding_mode === true,
    );
  }

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
  // server-side, so validate it before the record — a bad document costs
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
  const today = usageDateToday();

  // One usage record (ARCHITECTURE.md §6): record_api_call before
  // dispatch. "unavailable" means the record itself errored and the
  // gate fails closed — an uncounted call would make the usage meter
  // lie. There is no cap refusal any more (owner decision 2026-11-24):
  // record_api_call always returns a row. Used for the first call
  // below, and for every later call inside the loop.
  async function recordModelCall(): Promise<"ok" | "unavailable"> {
    const { data, error } = await admin.rpc("record_api_call", {
      p_user_id: userId,
    });
    if (error) return "unavailable";
    if (!data || data.length === 0) return "unavailable";
    return "ok";
  }

  // Gate for the first call: before the stream starts, so a record
  // failure can still be answered with a plain 503.
  const firstGate = await recordModelCall();
  if (firstGate === "unavailable") {
    return NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 });
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

  // The question is the new message, or the last user message on a
  // regenerate. It is the document query below and the silent
  // research query after it.
  const lastUserMessage = [...history]
    .reverse()
    .find((m) => m.role === "user");
  const questionText = message
    ? message.parts[0].text
    : lastUserMessage
      ? uiMessageText(lastUserMessage)
      : "";

  // Retrieve the document's relevant pages for the question (M5-4). The
  // question is the new message, or the last user message on a regenerate.
  // A retrieval failure is before dispatch: refund and fail closed.
  let documentPages: RetrievedPage[] = [];
  let documentContext: string | null = null;
  if (documentId && documentTitle !== null) {
    try {
      documentPages = await searchDocumentPages(
        supabase,
        user.id,
        documentId,
        questionText,
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

  // Vector retrieval (2026-11-25): memories and document passages
  // relevant by MEANING to this question, via the Voyage embeddings
  // stored on the rows (lib/vector-retrieval.ts). It adds to the
  // recency block above and to the document search below — rows those
  // paths already surfaced are filtered out, so nothing is repeated.
  // Unavailable (no key), failed, or nothing similar enough means
  // no block: the turn continues on the keyword/recency paths alone,
  // and a failure here never fails the reply.
  let vectorBlock: string | null = null;
  try {
    const vector = await retrieveVectorContext(admin, user.id, questionText, {
      memoryBlock,
      documentId: documentId ?? undefined,
      documentPageNumbers: documentPages.map((p) => p.page_number),
    });
    vectorBlock = vector?.block ?? null;
  } catch (err) {
    console.error("Vector retrieval failed unexpectedly", err);
  }

  // Silent web research (2026-11-24): when the question needs
  // current or external information, run ONE background Tavily
  // search before answering and feed the findings into the model's
  // instructions — never into the transcript. Skipped for document
  // questions (the document is the source of truth) and for
  // questions the heuristic says need no research. A missing key,
  // an empty result, or a provider failure means no research: the
  // turn continues without it, honestly, and the reply is not
  // marked as researched. A research failure never fails the turn:
  // runSilentResearch returns a status, and anything unexpected is
  // caught here so the model still answers from its own knowledge.
  // Runs after the model-call gate, before the stream starts, so a
  // research failure costs no extra model call.
  let research: Extract<SilentResearchResult, { status: "ok" }> | null =
    null;
  if (!documentId && shouldResearch(questionText)) {
    try {
      const result = await runSilentResearch({
        admin,
        userId,
        conversationId,
        query: questionText,
      });
      if (result.status === "ok") research = result;
    } catch (err) {
      console.error("Silent research failed unexpectedly", err);
    }
  }

  const instructionParts = [SYSTEM_PROMPT];
  if (memoryBlock) instructionParts.push(memoryBlock);
  if (vectorBlock) instructionParts.push(vectorBlock);
  if (documentContext) instructionParts.push(documentContext);
  if (research) instructionParts.push(research.contextBlock);
  const instructions = instructionParts.join("\n\n");

  // The model messages for the loop: history first, then each step's
  // assistant tool-call message and the tool-result message appended
  // after the server executes the calls.
  const modelMessages: ModelMessage[] =
    await convertToModelMessages(history);

  // Persist a system notice (depth overrun, mid-loop record failure).
  // The notice is the record the user sees on refresh; the stream simply ends
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

  // Failover state for this request (one backup attempt, shared by
  // the tool loop's calls; the next request starts on Groq again).
  const failover = createFailoverState();

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // The client learns the conversation ID first, so it can move to
      // /chat?id=<id> when the stream finishes.
      writer.write({
        type: "data-conversation",
        data: { conversationId },
      });
      // The model this request actually runs on, so the header shows
      // the real model — the flag and this id come from the same
      // source (modelIdFor), never from the client.
      writer.write({
        type: "data-model",
        data: { modelId: modelIdFor(codingMode) },
      });
      // Silent web research ran for this turn: the client shows a
      // small "researched the web" indicator on this reply. Only
      // written when research actually returned useful results —
      // never for an empty run, a failure, or a missing key.
      if (research) {
        writer.write({
          type: "data-researched",
          data: { sources: research.sources },
        });
      }

      // Tool loop (M3-17): at most MAX_MODEL_CALLS_PER_REQUEST model
      // calls. Each call is one step (stopWhen: stepCountIs(1)) and is
      // gated before dispatch — the first call was gated above, later
      // calls are gated at the top of the loop. A step with no tool
      // calls is the final answer and ends the loop.
      let callsMade = 0;
      for (;;) {
        // Model Gate for calls 2 and 3 (ARCHITECTURE.md §6): depth
        // check, then record. A fourth call is refused here — the
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
          const gate = await recordModelCall();
          if (gate === "unavailable") {
            await appendSystemNotice(
              "The model-call usage could not be recorded, so the turn ended here. Try again.",
            );
            break;
          }
        }

        let result: ReturnType<typeof streamText>;
        try {
          result = streamText({
            model: chatModel(failover, codingMode),
            instructions,
            messages: modelMessages,
            tools: toModelTools(),
            stopWhen: stepCountIs(1),
            abortSignal: request.signal,
            // The SDK's own retries are off: the single hot-swap
            // failover inside chatModel is the only retry, so one
            // request costs at most one primary attempt + one backup
            // attempt. Without this the SDK would retry Groq twice
            // before (and after) the failover.
            maxRetries: 0,
            // The history can contain system messages (tool outcomes
            // rendered as system by dbMessagesToUIMessages, "Reply
            // interrupted" lines, record-failure notices). They are written by
            // this server into the database — trusted, never
            // client-supplied — so the SDK's opt-in for system
            // messages in `messages` is safe here. Without it, the
            // next turn after any system message is persisted throws
            // InvalidPromptError.
            allowSystemInMessages: true,
          });
        } catch {
          // streamText threw before dispatch — the provider was never
          // called. The first call's record was already refunded
          // by the caller below; a later call's record is
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
              // A researched reply persists its flag (with sources) in
              // `parts` so the indicator survives a refresh — the
              // findings themselves stay out of the transcript: they
              // were context for this turn only. An aborted researched
              // reply keeps both markers.
              const researchedParts =
                research !== null
                  ? {
                      ...(aborted ? { incomplete: true } : {}),
                      researched: true,
                      sources: research.sources,
                    }
                  : aborted
                    ? { incomplete: true }
                    : null;
              try {
                await admin.rpc("append_message", {
                  p_user_id: user.id,
                  p_conversation_id: conversationId,
                  p_role: "assistant",
                  p_content: text,
                  p_parts:
                    researchedParts === null ? null : toJson(researchedParts),
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
