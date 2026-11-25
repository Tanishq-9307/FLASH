// Telegram config tests (Phase 3): env readers, owner lock, webhook
// secret verification. No values are ever real secrets — the tests use
// obvious placeholders.
import { afterEach, describe, expect, it } from "vitest";
import {
  isOwnerTelegramUser,
  isTelegramConfigured,
  telegramBotToken,
  telegramOwnerId,
  telegramWebhookSecret,
  verifyWebhookSecret,
} from "@/lib/telegram/config";

const ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_USER_ID",
  "TELEGRAM_WEBHOOK_SECRET",
  "CRON_SECRET",
  "TELEGRAM_PROACTIVE_SECRET",
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("telegram env readers", () => {
  it("returns null when unconfigured and the value when set", () => {
    expect(telegramBotToken()).toBeNull();
    expect(telegramOwnerId()).toBeNull();
    expect(telegramWebhookSecret()).toBeNull();
    process.env.TELEGRAM_BOT_TOKEN = "  token-123  ";
    expect(telegramBotToken()).toBe("token-123");
  });

  it("treats a blank value as unconfigured", () => {
    process.env.TELEGRAM_USER_ID = "   ";
    expect(telegramOwnerId()).toBeNull();
  });

  it("isTelegramConfigured needs token, owner id, and secret", () => {
    process.env.TELEGRAM_BOT_TOKEN = "tok";
    process.env.TELEGRAM_USER_ID = "42";
    expect(isTelegramConfigured()).toBe(false);
    process.env.TELEGRAM_WEBHOOK_SECRET = "secret";
    expect(isTelegramConfigured()).toBe(true);
  });
});

describe("isOwnerTelegramUser", () => {
  it("matches the owner's numeric id and nothing else", () => {
    process.env.TELEGRAM_USER_ID = "123456789";
    expect(isOwnerTelegramUser(123456789)).toBe(true);
    expect(isOwnerTelegramUser("123456789")).toBe(true);
    expect(isOwnerTelegramUser(987654321)).toBe(false);
    expect(isOwnerTelegramUser("987654321")).toBe(false);
    expect(isOwnerTelegramUser(null)).toBe(false);
    expect(isOwnerTelegramUser(undefined)).toBe(false);
    expect(isOwnerTelegramUser(123456789.5)).toBe(false);
  });

  it("matches nobody when no owner id is configured", () => {
    expect(isOwnerTelegramUser(1)).toBe(false);
  });
});

describe("verifyWebhookSecret", () => {
  it("accepts the exact secret and rejects anything else", () => {
    expect(verifyWebhookSecret("s3cr3t", "s3cr3t")).toBe(true);
    expect(verifyWebhookSecret("wrong", "s3cr3t")).toBe(false);
    expect(verifyWebhookSecret(null, "s3cr3t")).toBe(false);
    expect(verifyWebhookSecret("s3cr3t", null)).toBe(false);
    expect(verifyWebhookSecret(null, null)).toBe(false);
  });

  it("rejects a different-length secret without throwing", () => {
    expect(verifyWebhookSecret("short", "a-much-longer-secret")).toBe(false);
  });
});
