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

export function dbMessagesToUIMessages(rows: DbMessageRow[]): UIMessage[] {
  const messages: UIMessage[] = [];
  for (const row of rows) {
    messages.push({
      id: row.id,
      role: row.role as UIMessage["role"],
      parts: [{ type: "text", text: row.content }],
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
