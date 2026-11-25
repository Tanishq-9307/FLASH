// Telegram Bot API client tests (Phase 3): message chunking and send
// behaviour, with fetch stubbed — no network, no real token.
import { describe, expect, it, vi } from "vitest";
import {
  sendTelegramMessage,
  splitTelegramMessage,
} from "@/lib/telegram/client";
import { TELEGRAM_MAX_MESSAGE_CHARS } from "@/lib/telegram/config";

function okResponse() {
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

describe("splitTelegramMessage", () => {
  it("keeps a short message whole", () => {
    expect(splitTelegramMessage("hello")).toEqual(["hello"]);
  });

  it("splits a long message into <=4096-character chunks that rejoin", () => {
    const text = `${"a".repeat(4000)}\n${"b".repeat(4000)}\n${"c".repeat(100)}`;
    const chunks = splitTelegramMessage(text);
    expect(chunks.every((c) => c.length <= TELEGRAM_MAX_MESSAGE_CHARS)).toBe(
      true,
    );
    expect(chunks.join("")).toBe(text);
  });

  it("hard-slices a single over-long line", () => {
    const text = "x".repeat(9000);
    const chunks = splitTelegramMessage(text);
    expect(chunks).toHaveLength(3);
    expect(chunks.join("")).toBe(text);
  });
});

describe("sendTelegramMessage", () => {
  it("posts to the Bot API sendMessage endpoint with chat id and text", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const result = await sendTelegramMessage(
      "token-123",
      42,
      "hello",
      { fetchFn },
    );
    expect(result).toEqual({ ok: true, chunks: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://api.telegram.org/bottoken-123/sendMessage",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: 42,
      text: "hello",
    });
  });

  it("sends one request per chunk for a long message", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const result = await sendTelegramMessage("tok", 42, "y".repeat(9000), {
      fetchFn,
    });
    expect(result).toEqual({ ok: true, chunks: 3 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("returns ok:false on a Telegram error without leaking the token", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, description: "Forbidden: bot was blocked" }), {
          status: 403,
        }),
    );
    const result = await sendTelegramMessage("super-secret-token", 42, "hi", {
      fetchFn,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Forbidden: bot was blocked");
      expect(result.error).not.toContain("super-secret-token");
    }
  });

  it("returns ok:false (never throws) on a network error", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await sendTelegramMessage("tok", 42, "hi", { fetchFn });
    expect(result).toEqual({ ok: false, error: "telegram_send_failed: network down" });
  });
});
