// dbMessagesToUIMessages tests (M2-6, M3-20): database rows become
// UI messages — user, assistant, and system rows keep their role, an
// incomplete assistant row gains a "Reply interrupted" system line,
// and a tool-role row (the outcome of an approved action) becomes a
// system message, because the AI SDK's convertToModelMessages rejects
// role "tool" and would otherwise break the next chat turn after any
// approval reaches a final state.
import { describe, expect, it } from "vitest";
import {
  dbMessagesToUIMessages,
  researchedDataOf,
  researchedSourcesOf,
} from "@/lib/chat-history";

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

// Silent web research (2026-11-24): a researched assistant reply
// persists { researched: true, sources } in parts, and the loader
// turns it into a data-researched part so the indicator survives a
// refresh. The findings themselves are never in the transcript.
describe("researched replies", () => {
  const sources = [
    { title: "ISRO launches", url: "https://example.com/isro" },
    { title: "Second report", url: "https://example.com/second" },
  ];

  it("adds a data-researched part to a researched assistant row", () => {
    const messages = dbMessagesToUIMessages([
      {
        id: "1",
        role: "assistant",
        content: "hello",
        parts: { researched: true, sources },
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].parts).toEqual([
      { type: "text", text: "hello" },
      { type: "data-researched", data: { sources } },
    ]);
    expect(researchedDataOf(messages[0])).toEqual(sources);
  });

  it("keeps both markers on an interrupted researched reply", () => {
    const messages = dbMessagesToUIMessages([
      {
        id: "1",
        role: "assistant",
        content: "partial",
        parts: { incomplete: true, researched: true, sources },
      },
    ]);
    expect(messages.map((m) => m.role)).toEqual(["assistant", "system"]);
    expect(researchedDataOf(messages[0])).toEqual(sources);
    expect(messages[1].parts).toEqual([
      { type: "text", text: "Reply interrupted" },
    ]);
  });

  it("adds no data part to an unresearched reply", () => {
    const messages = dbMessagesToUIMessages([
      { id: "1", role: "assistant", content: "hello", parts: null },
    ]);
    expect(messages[0].parts).toEqual([{ type: "text", text: "hello" }]);
    expect(researchedDataOf(messages[0])).toBeNull();
  });

  it("researchedSourcesOf returns null unless the flag is exactly true", () => {
    expect(researchedSourcesOf(null)).toBeNull();
    expect(researchedSourcesOf({ researched: false, sources })).toBeNull();
    expect(researchedSourcesOf({ researched: "yes", sources })).toBeNull();
    expect(researchedSourcesOf({ researched: true })).toEqual([]);
    expect(researchedSourcesOf({ researched: true, sources })).toEqual(
      sources,
    );
  });

  it("drops malformed source entries instead of rendering fake sources", () => {
    expect(
      researchedSourcesOf({
        researched: true,
        sources: [
          { title: "ok", url: "https://example.com/ok" },
          { title: 42, url: "https://example.com/bad" },
          "not an object",
        ],
      }),
    ).toEqual([{ title: "ok", url: "https://example.com/ok" }]);
    expect(
      researchedDataOf({
        parts: [
          {
            type: "data-researched",
            data: { sources: [{ title: "ok", url: "https://example.com/ok" }] },
          },
        ],
      }),
    ).toEqual([{ title: "ok", url: "https://example.com/ok" }]);
    expect(researchedDataOf({ parts: [] })).toBeNull();
  });
});
