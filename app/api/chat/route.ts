// POST /api/chat (M1-7): a protected streaming chat route.
//
// Order of operations — the Model Gate (ARCHITECTURE.md §6):
// 1. Validate the body with Zod (message length limits; see below).
// 2. Verify the session with getUser(). Unauthenticated → 401, and nothing
//    is reserved.
// 3. Reserve one model call with reserve_api_call (cap from server config).
//    If it returns no row the cap is reached → explicit 429 the UI can
//    render, and no model call is made. If the reservation itself errors,
//    the gate fails closed with 503.
// 4. If the request was aborted before dispatch, refund the reservation
//    and answer 499 (client closed request). This is the only refund path:
//    once the model call is dispatched, a timeout, a dropped connection, or
//    a provider error is never refunded — the provider may already have
//    used quota.
// 5. Dispatch a single model call (single step only; no tools in M1) and
//    stream the reply.
//
// Depth: the gate allows 3 model calls per request, but M1 makes exactly
// one call per request (depth 0 of 3) because there are no tool calls yet.
// The depth counter arrives with multi-step tool calls in M3.
//
// Temporary risk (M1 only): the client sends chat history with each
// request. M2-6 replaces this with server-authoritative history, so a
// client can no longer forge or drop turns.
//
// Message limits (M1 judgement call — no spec number exists; the database
// stores up to 100,000 characters per message, DATABASE.md §3.2): each
// text part at most 8,000 characters, at most 50 messages per request.
import { NextResponse } from "next/server";
import { google } from "@ai-sdk/google";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
} from "ai";
import { z } from "zod";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { modelCallCap, usageDateToday } from "@/lib/config";
import { SYSTEM_PROMPT } from "@/lib/prompt";

export const maxDuration = 60;

const textPartSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1).max(8000),
});

const messageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(textPartSchema).min(1),
});

const bodySchema = z.object({
  messages: z.array(messageSchema).min(1).max(50),
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

  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
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

  let result: ReturnType<typeof streamText>;
  try {
    result = streamText({
      model: google("gemini-3.8-flash"),
      instructions: SYSTEM_PROMPT,
      messages: await convertToModelMessages(parsed.data.messages),
    });
  } catch {
    // streamText threw before dispatch — the provider was never called.
    await admin.rpc("refund_api_call", { p_user_id: user.id, p_usage_date: today });
    return NextResponse.json({ error: "provider_unavailable" }, { status: 502 });
  }

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}
