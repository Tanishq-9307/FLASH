// GET/POST /api/telegram/proactive — scheduled proactive check (Phase 3).
//
// Invoked on a schedule (Vercel Cron, once a day at 09:00 IST — see
// vercel.json), or manually with the same secret. Vercel Cron sends a
// GET, so both verbs share this handler.
//
// Authentication: the caller must present
// `Authorization: Bearer <secret>` where the secret is CRON_SECRET
// (set automatically by Vercel for Cron jobs) or
// TELEGRAM_PROACTIVE_SECRET (manual equivalent). When no secret is
// configured the route refuses everything (503) — an unauthenticated
// trigger must never be able to make the bot message the owner.
// A wrong or missing token gets 401; the secret itself is compared
// timing-safely and never logged.
//
// The check itself lives in lib/telegram/run-proactive.ts: it loads
// real tasks + usage, evaluates nudges, dedupes against
// telegram_nudges, sends at most 3, and logs every sent nudge in the
// activity log.
import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  telegramBotToken,
  telegramCronSecret,
  telegramOwnerId,
  verifyWebhookSecret,
} from "@/lib/telegram/config";
import { runProactiveCheck } from "@/lib/telegram/run-proactive";

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
    console.error("Telegram proactive: admin client failed", err);
    return NextResponse.json(
      { error: "telegram_not_configured" },
      { status: 503 },
    );
  }

  const result = await runProactiveCheck({
    admin,
    token: telegramBotToken(),
    ownerTelegramId: telegramOwnerId(),
  });
  console.error(`[telegram-proactive] ${result.status}: ${result.detail}`);
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
