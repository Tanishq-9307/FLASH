// @vitest-environment jsdom
// Paste-from-clipboard button tests (Phase 1, 2026-11-25): the granted
// path hands the text to onPaste, each failure path reports its message
// through onNotice and never calls onPaste, and the button is busy
// while a read is in flight. The clipboard reader is always injected —
// the real navigator.clipboard is never touched.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PasteFromClipboardButton } from "@/components/clipboard-paste-button";
import type { ClipboardReadResult } from "@/lib/clipboard";

afterEach(() => cleanup());

function renderButton(
  readClipboard: () => Promise<ClipboardReadResult>,
  onPaste = vi.fn(),
  onNotice = vi.fn(),
  disabled = false,
) {
  render(
    <PasteFromClipboardButton
      onPaste={onPaste}
      onNotice={onNotice}
      readClipboard={readClipboard}
      disabled={disabled}
    />,
  );
  return {
    onPaste,
    onNotice,
    button: screen.getByRole("button", { name: "Paste from clipboard" }),
  };
}

describe("PasteFromClipboardButton", () => {
  it("granted: passes the pasted text to onPaste and clears any notice", async () => {
    const { onPaste, onNotice, button } = renderButton(async () => ({
      ok: true,
      text: "pasted text",
    }));
    fireEvent.click(button);
    await waitFor(() => expect(onPaste).toHaveBeenCalledWith("pasted text"));
    expect(onNotice).toHaveBeenCalledWith(null);
  });

  it("denied: reports the blocked-access message and never calls onPaste", async () => {
    const { onPaste, onNotice, button } = renderButton(async () => ({
      ok: false,
      reason: "denied",
    }));
    fireEvent.click(button);
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(
        expect.stringContaining("Clipboard access was blocked"),
      ),
    );
    expect(onPaste).not.toHaveBeenCalled();
  });

  it("unavailable: reports the unavailable message and never calls onPaste", async () => {
    const { onPaste, onNotice, button } = renderButton(async () => ({
      ok: false,
      reason: "unavailable",
    }));
    fireEvent.click(button);
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(
        expect.stringContaining("isn't available in this browser"),
      ),
    );
    expect(onPaste).not.toHaveBeenCalled();
  });

  it("empty: reports the empty-clipboard message and never calls onPaste", async () => {
    const { onPaste, onNotice, button } = renderButton(async () => ({
      ok: false,
      reason: "empty",
    }));
    fireEvent.click(button);
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(
        expect.stringContaining("clipboard is empty"),
      ),
    );
    expect(onPaste).not.toHaveBeenCalled();
  });

  it("a reader that throws is reported as unavailable, not a crash", async () => {
    const { onPaste, onNotice, button } = renderButton(async () => {
      throw new Error("reader exploded");
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(
        expect.stringContaining("isn't available in this browser"),
      ),
    );
    expect(onPaste).not.toHaveBeenCalled();
    expect(button).toBeEnabled();
  });

  it("is busy while a read is in flight and cannot be double-clicked", async () => {
    let resolveRead: (result: ClipboardReadResult) => void = () => {};
    const readClipboard = vi.fn(
      (): Promise<ClipboardReadResult> =>
        new Promise<ClipboardReadResult>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const { onPaste, button } = renderButton(readClipboard);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Reading…");
    fireEvent.click(button);
    expect(readClipboard).toHaveBeenCalledTimes(1);
    resolveRead({ ok: true, text: "late text" });
    await waitFor(() => expect(onPaste).toHaveBeenCalledWith("late text"));
    expect(button).toBeEnabled();
  });

  it("does nothing when disabled", async () => {
    const readClipboard = vi.fn(
      async (): Promise<ClipboardReadResult> => ({
        ok: true,
        text: "x",
      }),
    );
    const { onPaste } = renderButton(readClipboard, vi.fn(), vi.fn(), true);
    fireEvent.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    expect(readClipboard).not.toHaveBeenCalled();
    expect(onPaste).not.toHaveBeenCalled();
  });
});
