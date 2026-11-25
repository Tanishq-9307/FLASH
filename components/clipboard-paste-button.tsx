// "Paste from clipboard" button (Phase 1, 2026-11-25). Shared by the
// chat composer, the new-note form and the new-task form. The clipboard
// is read ONLY here, in this button's click handler — a user gesture —
// never on mount, never in the background. Pasted text is handed to
// the parent as ordinary input through onPaste; the parent decides
// where it goes and nothing is sent anywhere until the user submits.
//
// A failed read is reported to the parent through onNotice with the
// plain-language message from lib/clipboard (which always names the
// Ctrl/Cmd+V fallback); the button itself shows no fake success.
"use client";

import { useState } from "react";
import {
  clipboardErrorMessage,
  readClipboardText,
  type ClipboardReadResult,
} from "@/lib/clipboard";

export type ClipboardReader = () => Promise<ClipboardReadResult>;

export function PasteFromClipboardButton({
  onPaste,
  onNotice,
  disabled = false,
  readClipboard = () => readClipboardText(),
  label = "Paste from clipboard",
}: {
  /** Called with the pasted text on a successful read. The text is
   * ordinary input — the parent inserts it into a field, never sends
   * it anywhere on its own. */
  onPaste: (text: string) => void;
  /** Called with a failure message (or null, clearing the last one)
   * so the parent can show it next to the field. */
  onNotice: (message: string | null) => void;
  disabled?: boolean;
  /** Injectable for tests; defaults to the real clipboard read. */
  readClipboard?: ClipboardReader;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    if (busy || disabled) return;
    setBusy(true);
    try {
      const result = await readClipboard();
      if (result.ok) {
        onNotice(null);
        onPaste(result.text);
      } else {
        onNotice(clipboardErrorMessage(result.reason));
      }
    } catch {
      // An injected reader threw: report it as unavailable rather
      // than crashing the composer. The real reader never throws.
      onNotice(clipboardErrorMessage("unavailable"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={disabled || busy}
      aria-label={label}
      title="Insert text from your clipboard"
      className="flex min-h-11 shrink-0 items-center rounded-md border border-border-strong bg-surface px-4 text-sm text-text-primary disabled:opacity-50"
    >
      {busy ? "Reading…" : label}
    </button>
  );
}
