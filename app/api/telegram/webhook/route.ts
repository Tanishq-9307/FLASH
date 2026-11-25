// POST /api/telegram/webhook — Telegram Bot API webhook (Phase 3).
//
// Serverless-friendly: one HTTP call per Telegram update, no long
// polling, no long-running process (the app runs on Vercel).
//
// Security, in order — a failure at any step answers without ever
// talking to the model or the bot:
// 1. The webhook secret: Telegram sends
//    `x-telegram-bot-api-secret-token` on every call; it must match
//    TELEGRAM_WEBHOOK_SECRET (timing-safe compare). Anything else gets
//    403 and no information about why.
// 2. The owner lock: the update's sender id must be TELEGRAM_USER_ID.
//    Anyone else gets a 200 with no reply and no error leak —
//    Telegram treats a 200 as delivered, so there is nothing for a
//    stranger to learn from the response either way.
// 3. The bot token must be configured, or the route answers 503 and
//    does nothing (inert, no crash).
//
// Handling: /start and /help answer with the command list; /tasks and
// /usage read real state; /stop and /resume flip the proactive switch
// in settings; /remind creates a reminder at once from a natural
// time ("tomorrow 9am") and /reminders lists the pending ones — an
// unparseable time is never guessed, the reply asks for
// clarification; any other text goes through the same chat pipeline
// as the web chat (lib/telegram/run-chat.ts). Non-text messages get a
// polite text-only reply. The route always answers 200 after the
// checks pass, so Telegram does not retry a delivered update.
//
// The webhook URL to register with BotFather is
// https://<deployment>/api/telegram/webhook (see docs/TELEGRAM.md).
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  modelCallCap,
  monthlySearchCap,
  usageDateToday,
  usageMonthStart,
} from "@/lib/config";
import {
  isOwnerTelegramUser,
  telegramBotToken,
  telegramOwnerId,
  telegramWebhookSecret,
  verifyWebhookSecret,
  TELEGRAM_SECRET_HEADER,
} from "@/lib/telegram/config";
import { sendTelegramMessage } from "@/lib/telegram/client";
import {
  formatTaskList,
  formatUsage,
  isTelegramCommand,
  parseTelegramCommand,
  TELEGRAM_HELP_TEXT,
} from "@/lib/telegram/commands";
import {
  clarificationFor,
  formatReminderTime,
  parseReminderRequest,
} from "@/lib/reminders/parse-time";
import { formatReminderList } from "@/lib/reminders/reminders";
import { resolveTelegramOwnerId } from "@/lib/telegram/owner";
import { runTelegramChat } from "@/lib/telegram/run-chat";

export const maxDuration = 60;

interface TelegramUpdate {
  message?: {
    message_id?: number;
    from?: { id?: number };
    chat?: { id?: number | string };
    text?: string;
  };
}

export async function POST(request: Request) {
  // 1. Webhook secret — fail closed when it is missing or wrong.
  const secret = telegramWebhookSecret();
  const provided = request.headers.get(TELEGRAM_SECRET_HEADER);
  if (!verifyWebhookSecret(provided, secret)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const message = update.message;
  if (!message || !message.from || !message.chat || message.chat.id === undefined) {
    // Not a message update (e.g. an edited message or callback): nothing
    // to answer, and a 200 so Telegram does not retry it.
    return NextResponse.json({ ok: true });
  }

  // 2. Owner lock — anyone else gets nothing: no reply, no error leak.
  if (!isOwnerTelegramUser(message.from.id)) {
    return NextResponse.json({ ok: true });
  }

  // 3. Bot token — inert when unconfigured, never a crash.
  const token = telegramBotToken();
  const ownerTelegramId = telegramOwnerId();
  if (!token || !ownerTelegramId) {
    return NextResponse.json(
      { error: "telegram_not_configured" },
      { status: 503 },
    );
  }
  const chatId = message.chat.id;

  async function reply(text: string): Promise<void> {
    const result = await sendTelegramMessage(token as string, chatId, text);
    if (!result.ok) console.error("Telegram webhook: reply failed", result.error);
  }

  const text = message.text?.trim() ?? "";
  if (text === "") {
    await reply(
      "I can only read text messages here — send your question as text.",
    );
    return NextResponse.json({ ok: true });
  }

  let admin: SupabaseClient<Database>;
  try {
    admin = createAdminClient();
  } catch (err) {
    console.error("Telegram webhook: admin client failed", err);
    return NextResponse.json(
      { error: "telegram_not_configured" },
      { status: 503 },
    );
  }

  const userId = await resolveTelegramOwnerId(admin);
  if (!userId) {
    return NextResponse.json(
      { error: "telegram_not_configured" },
      { status: 503 },
    );
  }

  // Commands.
  const parsed = parseTelegramCommand(text);
  if (parsed !== null) {
    if (!isTelegramCommand(parsed.command)) {
      await reply(
        `Unknown command ${parsed.command}. Send /help for what I can do.`,
      );
      return NextResponse.json({ ok: true });
    }
    switch (parsed.command) {
      case "/start":
      case "/help":
        await reply(TELEGRAM_HELP_TEXT);
        return NextResponse.json({ ok: true });
      case "/tasks": {
        const { data: tasks, error } = await admin
          .from("tasks")
          .select("id, title, due_date, status, created_at, updated_at")
          .eq("user_id", userId)
          .order("created_at", { ascending: true });
        if (error || !tasks) {
          await reply("I couldn't load your tasks right now. Try again in a bit.");
        } else {
          await reply(formatTaskList(tasks));
        }
        return NextResponse.json({ ok: true });
      }
      case "/usage": {
        const today = usageDateToday();
        const { data: usageRow } = await admin
          .from("api_usage")
          .select("model_calls")
          .eq("user_id", userId)
          .eq("usage_date", today)
          .maybeSingle();
        const { data: searchRows } = await admin
          .from("search_usage")
          .select("searches")
          .eq("user_id", userId)
          .gte("usage_date", usageMonthStart());
        const searchUsage = (searchRows ?? []).reduce(
          (total, row) => total + (row.searches ?? 0),
          0,
        );
        await reply(
          formatUsage(
            usageRow?.model_calls ?? 0,
            modelCallCap(),
            searchUsage,
            monthlySearchCap(),
          ),
        );
        return NextResponse.json({ ok: true });
      }
      case "/stop":
      case "/resume": {
        const enabled = parsed.command === "/resume";
        const { error } = await admin.from("settings").upsert(
          { user_id: userId, telegram_proactive_enabled: enabled },
          { onConflict: "user_id" },
        );
        if (error) {
          await reply(
            "I couldn't change the proactive setting right now. Try again in a bit.",
          );
        } else {
          await reply(
            enabled
              ? "Proactive nudges are back on — I'll nudge you when something is due."
              : "Proactive nudges are off. Send /resume to turn them back on.",
          );
        }
        return NextResponse.json({ ok: true });
      }
      case "/remind": {
        // Direct command: an explicit instruction, so the reminder
        // is created at once — no approval round trip, exactly like
        // /stop flips the switch directly. An unparseable time is
        // never guessed: the reply asks for clarification.
        const request = parseReminderRequest(parsed.args, new Date());
        if (!request.ok) {
          await reply(
            request.reason === "no_time"
              ? `I couldn't tell when you mean. ${clarificationFor("no_time")}`
              : clarificationFor("no_message"),
          );
          return NextResponse.json({ ok: true });
        }
        const { error } = await admin.from("reminders").insert({
          user_id: userId,
          message: request.message,
          remind_at: request.at.toISOString(),
          status: "pending",
          source: "telegram",
        });
        if (error) {
          await reply(
            "I couldn't save that reminder right now. Try again in a bit.",
          );
        } else {
          await reply(
            `Reminder set: "${request.message}" — ${formatReminderTime(request.at)}. I'll message you here at that time.`,
          );
        }
        return NextResponse.json({ ok: true });
      }
      case "/reminders": {
        const { data: reminders, error } = await admin
          .from("reminders")
          .select(
            "id, user_id, message, remind_at, status, source, sent_at, created_at, updated_at",
          )
          .eq("user_id", userId)
          .order("remind_at", { ascending: true });
        if (error || !reminders) {
          await reply(
            "I couldn't load your reminders right now. Try again in a bit.",
          );
        } else {
          await reply(formatReminderList(reminders));
        }
        return NextResponse.json({ ok: true });
      }
    }
  }

  // Plain text: through the web chat pipeline, reply over Telegram.
  const { reply: chatReply } = await runTelegramChat(admin, userId, text);
  await reply(chatReply);
  return NextResponse.json({ ok: true });
}
