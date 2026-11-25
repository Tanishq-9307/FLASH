// Database rows -> UI messages (M2-6).
//
// Plain language: the chat history lives in the database as plain rows
// (one row per message). The screen and the model both need the AI SDK's
// message shape instead, so this translates rows into that shape. A row is
// one message: user rows and assistant rows become a text message, system
// rows the same. An assistant row whose `parts` carry the incomplete
// marker (M2-6: the stream was cut off before the reply finished) becomes
// TWO messages — the partial reply, then a system line that says "Reply
// interrupted", so the user can see the reply never finished instead of
// wondering why it stops mid-sentence.
//
// Tool rows (M3-20) become SYSTEM messages: the database stores the
// outcome of an approved action as a tool-role row, but the AI SDK's
// convertToModelMessages only accepts system, user, and assistant
// roles — a tool-role message throws "Unsupported role: tool", which
// would break the next chat turn after any approval reaches a final
// state. The content is a human-readable outcome sentence ("The task
// was created"), so as a system message the model gets the same
// context and the screen shows it as a centred notice. The database
// row itself keeps role "tool" — only this conversion changes.
import type { UIMessage } from "ai";

export type DbMessageRow = {
  id: string;
  role: string;
  content: string;
  parts: unknown;
};

function isIncomplete(parts: unknown): boolean {
  return (
    typeof parts === "object" &&
    parts !== null &&
    (parts as { incomplete?: unknown }).incomplete === true
  );
}

/** The sources of a researched assistant reply, from the persisted
 * `parts` object ({ researched: true, sources: [{ title, url }] }).
 * Null when the reply was not researched, or the stored sources are
 * not well-formed — a malformed row never renders a fake indicator. */
export function researchedSourcesOf(
  parts: unknown,
): Array<{ title: string; url: string }> | null {
  if (typeof parts !== "object" || parts === null) return null;
  const record = parts as {
    researched?: unknown;
    sources?: unknown;
  };
  if (record.researched !== true) return null;
  if (!Array.isArray(record.sources)) return [];
  const sources: Array<{ title: string; url: string }> = [];
  for (const item of record.sources) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as { title?: unknown }).title === "string" &&
      typeof (item as { url?: unknown }).url === "string"
    ) {
      sources.push({
        title: (item as { title: string }).title,
        url: (item as { url: string }).url,
      });
    }
  }
  return sources;
}

/** The sources of a UI message's "researched the web" indicator, if
 * the message carries a data-researched part (persisted replies get
 * one from dbMessagesToUIMessages; live streams get one from the
 * server's data-researched data part). Null when the reply was not
 * researched. */
export function researchedDataOf(message: {
  parts?: unknown;
}): Array<{ title: string; url: string }> | null {
  const parts = (message.parts ?? []) as Array<{
    type?: string;
    data?: unknown;
  }>;
  for (const part of parts) {
    if (part.type !== "data-researched") continue;
    const data = part.data as { sources?: unknown } | null;
    if (typeof data !== "object" || data === null) return [];
    if (!Array.isArray(data.sources)) return [];
    const sources: Array<{ title: string; url: string }> = [];
    for (const item of data.sources) {
      if (
        typeof item === "object" &&
        item !== null &&
        typeof (item as { title?: unknown }).title === "string" &&
        typeof (item as { url?: unknown }).url === "string"
      ) {
        sources.push({
          title: (item as { title: string }).title,
          url: (item as { url: string }).url,
        });
      }
    }
    return sources;
  }
  return null;
}

export function dbMessagesToUIMessages(rows: DbMessageRow[]): UIMessage[] {
  const messages: UIMessage[] = [];
  for (const row of rows) {
    const parts: UIMessage["parts"] = [
      { type: "text", text: row.content },
    ];
    // A researched reply (silent web research, 2026-11-24) carries a
    // data-researched part so the indicator survives a refresh. The
    // model never sees it: convertToModelMessages drops data parts
    // without a convertDataPart, and the research findings themselves
    // were already in that turn's instructions, never in the
    // transcript — so the next turn gets the clean text only.
    if (row.role === "assistant") {
      const sources = researchedSourcesOf(row.parts);
      if (sources !== null) {
        parts.push({
          type: "data-researched",
          data: { sources },
        });
      }
    }
    messages.push({
      id: row.id,
      role: row.role === "tool" ? "system" : (row.role as UIMessage["role"]),
      parts,
    });
    if (row.role === "assistant" && isIncomplete(row.parts)) {
      messages.push({
        id: `${row.id}-interrupted`,
        role: "system",
        parts: [{ type: "text", text: "Reply interrupted" }],
      });
    }
  }
  return messages;
}

/** The text of a UI message (its text parts joined). */
export function uiMessageText(message: { parts?: unknown }): string {
  const parts = (message.parts ?? []) as Array<{ type?: string; text?: string }>;
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}
