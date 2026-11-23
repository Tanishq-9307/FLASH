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

export function dbMessagesToUIMessages(rows: DbMessageRow[]): UIMessage[] {
  const messages: UIMessage[] = [];
  for (const row of rows) {
    messages.push({
      id: row.id,
      role: row.role === "tool" ? "system" : (row.role as UIMessage["role"]),
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
