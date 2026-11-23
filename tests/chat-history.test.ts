// dbMessagesToUIMessages tests (M2-6, M3-20): database rows become
// UI messages — user, assistant, and system rows keep their role, an
// incomplete assistant row gains a "Reply interrupted" system line,
// and a tool-role row (the outcome of an approved action) becomes a
// system message, because the AI SDK's convertToModelMessages rejects
// role "tool" and would otherwise break the next chat turn after any
// approval reaches a final state.
import { describe, expect, it } from "vitest";
import { dbMessagesToUIMessages } from "@/lib/chat-history";

describe("dbMessagesToUIMessages", () => {
  it("keeps user, assistant, and system roles with their text", () => {
    const messages = dbMessagesToUIMessages([
      { id: "1", role: "user", content: "hi", parts: null },
      { id: "2", role: "assistant", content: "hello", parts: null },
      { id: "3", role: "system", content: "note", parts: null },
    ]);
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "system",
    ]);
    expect(messages.map((m) => m.id)).toEqual(["1", "2", "3"]);
    expect(messages[1].parts).toEqual([{ type: "text", text: "hello" }]);
  });

  it("renders a tool-role row as a system message with the same text", () => {
    const messages = dbMessagesToUIMessages([
      { id: "1", role: "user", content: "create a task", parts: null },
      {
        id: "2",
        role: "tool",
        content: "The task was created.",
        parts: { approval_id: "x", tool_name: "create_task" },
      },
    ]);
    expect(messages.map((m) => m.role)).toEqual(["user", "system"]);
    expect(messages[1].id).toBe("2");
    expect(messages[1].parts).toEqual([
      { type: "text", text: "The task was created." },
    ]);
  });

  it("adds a Reply interrupted system line after an incomplete assistant row", () => {
    const messages = dbMessagesToUIMessages([
      {
        id: "1",
        role: "assistant",
        content: "partial",
        parts: { incomplete: true },
      },
    ]);
    expect(messages.map((m) => m.role)).toEqual(["assistant", "system"]);
    expect(messages[1].parts).toEqual([
      { type: "text", text: "Reply interrupted" },
    ]);
  });
});
