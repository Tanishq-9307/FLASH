// Telegram Bot API client (Phase 3, 2026-11-25). Sends text messages
// only — voice and attachments are out of scope for this phase.
//
// The token never appears in a log line or an error message: a failed
// call reports the HTTP status and Telegram's description, never the
// URL (which carries the token). Long replies are split into
// <=4096-character chunks at a line break where possible, so a long
// model reply still arrives whole instead of being truncated by
// Telegram. `fetchFn` is injectable so tests can stub the network.
import {
  TELEGRAM_API_BASE,
  TELEGRAM_MAX_MESSAGE_CHARS,
} from "./config";

export type TelegramSendResult =
  | { ok: true; chunks: number }
  | { ok: false; error: string };

export interface TelegramClientDeps {
  fetchFn?: typeof fetch;
}

/** Split a message into <=4096-character chunks, preferring a line
 * break near the limit so a chunk never cuts a line in half when it
 * can be avoided. A single line longer than the limit is hard-sliced. */
export function splitTelegramMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_MESSAGE_CHARS) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > TELEGRAM_MAX_MESSAGE_CHARS) {
    const window = rest.slice(0, TELEGRAM_MAX_MESSAGE_CHARS + 1);
    const breakAt = window.lastIndexOf("\n");
    const cut = breakAt > 0 ? breakAt + 1 : TELEGRAM_MAX_MESSAGE_CHARS;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/** Send one text message (split into chunks when needed) to a Telegram
 * chat via the Bot API. Returns ok:false — never throws — on a network
 * error, a non-2xx response, or a Telegram error, so the caller can
 * report the failure honestly instead of crashing the webhook. */
export async function sendTelegramMessage(
  token: string,
  chatId: string | number,
  text: string,
  deps: TelegramClientDeps = {},
): Promise<TelegramSendResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const chunks = splitTelegramMessage(text);
  for (const chunk of chunks) {
    let response: Response;
    try {
      response = await fetchFn(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
      });
    } catch (err) {
      return {
        ok: false,
        error: `telegram_send_failed: ${err instanceof Error ? err.message : "network error"}`,
      };
    }
    if (!response.ok) {
      let description = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { description?: unknown };
        if (typeof body.description === "string" && body.description !== "") {
          description = body.description;
        }
      } catch {
        // Non-JSON error body: the status above is the honest report.
      }
      return { ok: false, error: `telegram_send_failed: ${description}` };
    }
  }
  return { ok: true, chunks: chunks.length };
}
