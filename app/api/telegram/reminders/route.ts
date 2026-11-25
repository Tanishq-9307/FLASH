// GET/POST /api/telegram/reminders — scheduled reminder delivery
// (Phase 3).
//
// Invoked on a schedule (Vercel Cron, every 5 minutes — see
// vercel.json), or manually with the same secret. Vercel Cron sends
// a GET, so both verbs share this handler.
//
// Authentication: exactly the same gate as the proactive route —
// the caller must present `Authorization: Bearer <secret>` where the
// secret is CRON_SECRET (set automatically by Vercel for Cron jobs)
// or TELEGRAM_PROACTIVE_SECRET (manual equivalent). When no secret
// is configured the route refuses everything (503). A wrong or
// missing token gets 401; the secret itself is compared
// timing-safely and never logged.
//
// The delivery itself lives in lib/telegram/run-reminders.ts: it
// claims due reminders atomically, sends each over Telegram, marks
// it sent, and logs the delivery in the activity log. Reminders
// fire at the exact time the owner set — including inside the
// 23:00–07:00 quiet hours, which apply only to unsolicited
// proactive nudges, never to a reminder the owner asked for.
import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  telegramBotToken,
  telegramCronSecret,
  telegramOwnerId,
  verifyWebhookSecret,
} from "@/lib/telegram/config";
import { runRemindersCheck } from "@/lib/telegram/run-reminders";

async function handle(request: Request): Promise<NextResponse> {
  const expected = telegramCronSecret();
  if (expected === null) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  const header = request.headers.get("authorization");
  const provided =
    header !== null && header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : null;
  if (!verifyWebhookSecret(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (err) {
    console.error("Telegram reminders: admin client failed", err);
    return NextResponse.json(
      { error: "telegram_not_configured" },
      { status: 503 },
    );
  }

  const result = await runRemindersCheck({
    admin,
    token: telegramBotToken(),
    ownerTelegramId: telegramOwnerId(),
  });
  console.error(`[telegram-reminders] ${result.status}: ${result.detail}`);
  return NextResponse.json({
    status: result.status,
    sent: result.sent,
    detail: result.detail,
  });
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
