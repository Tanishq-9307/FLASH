// Telegram configuration (Phase 3, 2026-11-25). Server environment only —
// never NEXT_PUBLIC_, never the client, never committed values.
//
// Env vars the owner must supply (see docs/TELEGRAM.md):
//   TELEGRAM_BOT_TOKEN      — from BotFather (@BotFather in Telegram).
//   TELEGRAM_USER_ID        — the owner's numeric Telegram user id (the
//                             bot only ever talks to this one id).
//   TELEGRAM_WEBHOOK_SECRET — a random string the owner invents; Telegram
//                             sends it back on every webhook call and the
//                             server rejects any call without it.
//   CRON_SECRET             — Vercel sets this automatically for Cron
//                             jobs; TELEGRAM_PROACTIVE_SECRET is the manual
//                             equivalent for a scheduled call elsewhere.
// The owner's Supabase user is resolved by email (the single-account
// address from M1-0), so no extra id env var is needed.
import { timingSafeEqual } from "node:crypto";

/** The single account this app serves (M1-0). */
export const TELEGRAM_OWNER_EMAIL = "tanishq.jshinde@gmail.com";

/** Telegram Bot API base URL. */
export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** One Telegram message holds at most 4096 characters. */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

/** The header Telegram sends the webhook secret token in. */
export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

function envValue(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return null;
  return raw.trim();
}

/** The bot token from BotFather, or null when not configured. */
export function telegramBotToken(): string | null {
  return envValue("TELEGRAM_BOT_TOKEN");
}

/** The owner's numeric Telegram user id, or null when not configured. */
export function telegramOwnerId(): string | null {
  return envValue("TELEGRAM_USER_ID");
}

/** The webhook secret token, or null when not configured. */
export function telegramWebhookSecret(): string | null {
  return envValue("TELEGRAM_WEBHOOK_SECRET");
}

/** The secret a scheduled proactive call must present: Vercel's
 * CRON_SECRET first, then the manual TELEGRAM_PROACTIVE_SECRET. */
export function telegramCronSecret(): string | null {
  return envValue("CRON_SECRET") ?? envValue("TELEGRAM_PROACTIVE_SECRET");
}

/** True only when the bot token, the owner id, and the webhook secret
 * are all configured — the minimum for the webhook to do anything. */
export function isTelegramConfigured(): boolean {
  return (
    telegramBotToken() !== null &&
    telegramOwnerId() !== null &&
    telegramWebhookSecret() !== null
  );
}

/** True only for the owner's Telegram user id. The comparison is on
 * the string form, so a numeric id from Telegram and the env string
 * compare equal; anything else (including a missing id) is not the
 * owner. */
export function isOwnerTelegramUser(id: unknown): boolean {
  const owner = telegramOwnerId();
  if (owner === null) return false;
  if (typeof id === "number") return Number.isInteger(id) && String(id) === owner;
  if (typeof id === "string") return id !== "" && id === owner;
  return false;
}

/** Timing-safe check of the secret Telegram sends on a webhook call
 * against the configured secret. A missing header, a missing
 * configured secret, or a length mismatch all fail — never an
 * exception, never a timing leak about how close the guess was. */
export function verifyWebhookSecret(
  provided: string | null,
  expected: string | null,
): boolean {
  if (provided === null || expected === null) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
