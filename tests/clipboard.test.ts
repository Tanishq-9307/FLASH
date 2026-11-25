// Clipboard library tests (Phase 1, 2026-11-25): the paste flow's
// three read paths (granted / denied / unavailable), the empty
// clipboard, and the insert-at-cursor helper the composer and the
// boards share. The clipboard source is always an injected fake —
// the real navigator.clipboard is never read in tests.
import { describe, expect, it } from "vitest";
import {
  clipboardErrorMessage,
  insertAtCursor,
  readClipboardText,
  type ClipboardSource,
} from "@/lib/clipboard";

function fakeClipboard(
  readText: () => Promise<unknown>,
): ClipboardSource {
  return { readText };
}

function notAllowedError() {
  const error = new Error("Permission denied");
  error.name = "NotAllowedError";
  return error;
}

describe("readClipboardText", () => {
  it("granted: returns the pasted text", async () => {
    const result = await readClipboardText(
      fakeClipboard(async () => "hello from the clipboard"),
    );
    expect(result).toEqual({ ok: true, text: "hello from the clipboard" });
  });

  it("denied: a NotAllowedError is a denied result", async () => {
    const result = await readClipboardText(
      fakeClipboard(async () => {
        throw notAllowedError();
      }),
    );
    expect(result).toEqual({ ok: false, reason: "denied" });
  });

  it("denied: a SecurityError is a denied result", async () => {
    const error = new Error("Blocked");
    error.name = "SecurityError";
    const result = await readClipboardText(
      fakeClipboard(async () => {
        throw error;
      }),
    );
    expect(result).toEqual({ ok: false, reason: "denied" });
  });

  it("unavailable: no clipboard source at all", async () => {
    expect(await readClipboardText(undefined)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await readClipboardText(null)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("unavailable: a clipboard object without readText", async () => {
    expect(await readClipboardText({} as ClipboardSource)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("unavailable: a non-permission failure while reading", async () => {
    const result = await readClipboardText(
      fakeClipboard(async () => {
        throw new Error("read failed");
      }),
    );
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("unavailable: a non-Error rejection while reading", async () => {
    const result = await readClipboardText(
      fakeClipboard(async () => {
        throw "boom";
      }),
    );
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("unavailable: readText resolves to a non-string", async () => {
    const result = await readClipboardText(
      fakeClipboard(async () => 42),
    );
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("empty: an empty clipboard is an empty result, not a success", async () => {
    expect(
      await readClipboardText(fakeClipboard(async () => "")),
    ).toEqual({ ok: false, reason: "empty" });
  });

  it("empty: whitespace-only clipboard text is empty", async () => {
    expect(
      await readClipboardText(fakeClipboard(async () => "  \n\t ")),
    ).toEqual({ ok: false, reason: "empty" });
  });
});

describe("clipboardErrorMessage", () => {
  it("every reason has a distinct, non-empty message", () => {
    const messages = (["unavailable", "denied", "empty"] as const).map(
      (reason) => clipboardErrorMessage(reason),
    );
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(0);
    }
    expect(new Set(messages).size).toBe(3);
  });

  it("unavailable and denied both name the keyboard-paste fallback", () => {
    expect(clipboardErrorMessage("unavailable")).toContain("Ctrl+V");
    expect(clipboardErrorMessage("unavailable")).toContain("Cmd+V");
    expect(clipboardErrorMessage("denied")).toContain("Ctrl+V");
    expect(clipboardErrorMessage("denied")).toContain("Cmd+V");
  });

  it("denied names permission; empty names the empty clipboard", () => {
    expect(clipboardErrorMessage("denied")).toMatch(/blocked/i);
    expect(clipboardErrorMessage("empty")).toMatch(/clipboard is empty/i);
  });
});

describe("insertAtCursor", () => {
  it("appends to an empty field with the caret at the end", () => {
    expect(insertAtCursor("", "hello")).toEqual({
      value: "hello",
      caret: 5,
    });
  });

  it("appends at the end, joining with a space when needed", () => {
    expect(insertAtCursor("hello", "world")).toEqual({
      value: "hello world",
      caret: 11,
    });
  });

  it("does not double the space when the field already ends with one", () => {
    expect(insertAtCursor("hello ", "world")).toEqual({
      value: "hello world",
      caret: 11,
    });
  });

  it("does not add a space when the pasted text starts with one", () => {
    expect(insertAtCursor("hello", " world")).toEqual({
      value: "hello world",
      caret: 11,
    });
  });

  it("inserts at the caret in the middle of the text", () => {
    expect(insertAtCursor("hello world", "brave ", 6, 6)).toEqual({
      value: "hello brave world",
      caret: 12,
    });
  });

  it("replaces the selection, keeping the text around it", () => {
    expect(insertAtCursor("hello world", "there", 6, 11)).toEqual({
      value: "hello there",
      caret: 11,
    });
  });

  it("clamps an out-of-range caret to the end", () => {
    expect(insertAtCursor("hi", "!", 99, 99)).toEqual({
      value: "hi !",
      caret: 4,
    });
  });
});
