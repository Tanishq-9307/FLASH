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
// 5. Reserve one model call with reserve_api_call (cap from server config).
//    If it returns no row the cap is reached → explicit 429 the UI can
//    render, and no model call is made. If the reservation itself errors,
//    the gate fails closed with 503.
// 6. If the request was aborted before dispatch, refund the reservation
//    and answer 499 (client closed request). This is the only refund path:
//    once the model call is dispatched, a timeout, a dropped connection, or
//    a provider error is never refunded — the provider may already have
//    used quota.
// 7. Load the history from the database (including the message just
//    inserted) and dispatch a single model call (single step only; no tools
//    in M2) and stream the reply.
// 8. Persist the assistant reply with append_message (service role) when
//    the stream ends. A complete reply is stored plain; an aborted stream
//    stores the partial text with an incomplete marker in `parts`, and the
//    UI shows "Reply interrupted". A provider error stores nothing — the
//    user message stays and Retry/regenerate handles it.
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
  const { conversationId: requestedId, message, regenerate } = parsed.data;

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

  let result: ReturnType<typeof streamText>;
  try {
    result = streamText({
      model: google("gemini-3.8-flash"),
      instructions: SYSTEM_PROMPT,
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
          },
        }),
      );
    },
  });

  return createUIMessageStreamResponse({ stream });
}
