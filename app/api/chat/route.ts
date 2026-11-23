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
//    the gate fails closed with 503.
// 6. If the request was aborted before dispatch, refund the reservation
//    and answer 499 (client closed request). This is the only refund path:
//    once the model call is dispatched, a timeout, a dropped connection, or
//    a provider error is never refunded — the provider may already have
//    used quota. (A document retrieval failure below also refunds: the
//    model was never called, so the call was never dispatched.)
// 7. Load the history from the database (including the message just
//    inserted) and dispatch a single model call (single step only; no tools
//    in M2) and stream the reply. For a document question, the relevant
//    pages are retrieved first (full-text search over document_pages for
//    the user's question) and enter the prompt inside a delimited
//    untrusted-data block; the answer must cite them as [p. N] or say the
//    document does not say.
// 8. Persist the assistant reply with append_message (service role) when
//    the stream ends. A complete reply is stored plain; an aborted stream
//    stores the partial text with an incomplete marker in `parts`, and the
//    UI shows "Reply interrupted". A provider error stores nothing — the
//    user message stays and Retry/regenerate handles it. For a document
//    question, the reply's citations are verified against the retrieved
//    pages; an unverified reply gets a system note saying so, instead of
//    being presented as sourced.
//
// The conversation ID reaches the client as a data part at the start of
// the stream, so the client can move to /chat?id=<id> when the stream
// finishes and a refresh reloads the conversation from the database.
//
// Depth: the gate allows 3 model calls per request, but M2 makes exactly
// one call per request (depth 0 of 3) because there are no tool calls yet.
// The depth counter arrives with multi-step tool calls in M3.
import { NextResponse } from "next/server";
import { google } from "@ai-sdk/google";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
} from "ai";
import { z } from "zod";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { modelCallCap, usageDateToday } from "@/lib/config";
import { SYSTEM_PROMPT } from "@/lib/prompt";
import { dbMessagesToUIMessages, uiMessageText } from "@/lib/chat-history";
import {
  searchDocumentPages,
  type RetrievedPage,
} from "@/lib/documents/retrieve";
import { verifyAnswerCitations } from "@/lib/documents/citations";
import { buildDocumentPrompt } from "@/lib/documents/document-prompt";

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
  const { data: reserved, error: reserveError } = await admin.rpc("reserve_api_call", {
    p_user_id: user.id,
    p_cap: cap,
  });
  if (reserveError) {
    return NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 });
  }
  if (!reserved || reserved.length === 0) {
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

  let result: ReturnType<typeof streamText>;
  try {
    result = streamText({
      model: google("gemini-3.8-flash"),
      instructions: documentContext
        ? `${SYSTEM_PROMPT}\n\n${documentContext}`
        : SYSTEM_PROMPT,
      messages: await convertToModelMessages(history),
      abortSignal: request.signal,
    });
  } catch {
    // streamText threw before dispatch — the provider was never called.
    await admin.rpc("refund_api_call", { p_user_id: user.id, p_usage_date: today });
    return NextResponse.json({ error: "provider_unavailable" }, { status: 502 });
  }

  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      // The client learns the conversation ID first, so it can move to
      // /chat?id=<id> when the stream finishes.
      writer.write({
        type: "data-conversation",
        data: { conversationId },
      });
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
    },
  });

  return createUIMessageStreamResponse({ stream });
}
