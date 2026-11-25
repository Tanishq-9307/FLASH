// Clipboard access (Phase 1, 2026-11-25). The browser Clipboard API
// (navigator.clipboard.readText) is only ever called from a user gesture
// — the "Paste from clipboard" button — never on page load or in the
// background. Pasted text is ordinary user input: it is inserted into
// the composer/field and only sent when the user submits, exactly like
// text typed by hand or pasted with Ctrl/Cmd+V.
//
// The API needs a secure context and the user's permission, so a read
// can fail two honest ways: the API is unavailable (insecure context,
// unsupported browser) or permission is denied. Both are reported to
// the user with a fallback (normal keyboard paste), never silently
// swallowed and never presented as success.

/** The outcome of one clipboard read. */
export type ClipboardReadResult =
  | { ok: true; text: string }
  | {
      ok: false;
      /** "unavailable": no Clipboard API in this browser/context, or
       * the read failed for a reason other than permission.
       * "denied": the user (or browser) refused clipboard permission.
       * "empty": the read succeeded but the clipboard holds no text. */
      reason: "unavailable" | "denied" | "empty";
    };

/** The only part of the Clipboard API this module touches, so tests
 * can pass a fake and the component can use the real navigator. */
export type ClipboardSource = {
  readText: () => Promise<unknown>;
} | null | undefined;

/** The real clipboard in this environment, if the API exists. In an
 * insecure context the browser does not expose navigator.clipboard
 * at all, so this is undefined there — the "unavailable" path. */
function realClipboard(): ClipboardSource {
  if (typeof navigator === "undefined") return undefined;
  const clipboard = (
    navigator as Navigator & { clipboard?: { readText: () => Promise<unknown> } }
  ).clipboard;
  return clipboard ?? undefined;
}

/** Read the clipboard once, from a user gesture. Never throws: every
 * failure is a typed result the UI can explain. */
export async function readClipboardText(
  clipboard: ClipboardSource = realClipboard(),
): Promise<ClipboardReadResult> {
  if (!clipboard || typeof clipboard.readText !== "function") {
    return { ok: false, reason: "unavailable" };
  }
  let text: unknown;
  try {
    text = await clipboard.readText();
  } catch (error) {
    // A permission refusal is the only failure the user can fix by
    // allowing access; anything else is reported as unavailable.
    if (
      error instanceof Error &&
      (error.name === "NotAllowedError" || error.name === "SecurityError")
    ) {
      return { ok: false, reason: "denied" };
    }
    return { ok: false, reason: "unavailable" };
  }
  if (typeof text !== "string") {
    // The API resolved to something that is not text: a broken
    // implementation, not an empty clipboard.
    return { ok: false, reason: "unavailable" };
  }
  if (text.trim() === "") {
    return { ok: false, reason: "empty" };
  }
  return { ok: true, text };
}

/** The message shown in the UI when a clipboard read fails. Every
 * message names the ordinary keyboard paste as the fallback, so the
 * user is never stuck. */
export function clipboardErrorMessage(
  reason: Exclude<ClipboardReadResult, { ok: true }>["reason"],
): string {
  switch (reason) {
    case "denied":
      return (
        "Clipboard access was blocked. Allow clipboard access for this site, " +
        "or paste with Ctrl+V (Cmd+V on Mac) instead."
      );
    case "empty":
      return "The clipboard is empty — copy some text first, then try again.";
    case "unavailable":
      return (
        "Clipboard access isn't available in this browser. " +
        "Paste with Ctrl+V (Cmd+V on Mac) instead."
      );
  }
}

/** Insert pasted text into a field's current value. With a selection,
 * the text replaces the selection at the caret; without one it is
 * appended at the end. A single space joins the two parts when
 * neither side already has whitespace there, so "hello" + "world"
 * becomes "hello world" instead of "helloworld". Returns the new
 * value and the caret position just after the inserted text. */
export function insertAtCursor(
  current: string,
  insertion: string,
  selectionStart?: number,
  selectionEnd?: number,
): { value: string; caret: number } {
  const start =
    typeof selectionStart === "number"
      ? Math.max(0, Math.min(selectionStart, current.length))
      : current.length;
  const end =
    typeof selectionEnd === "number"
      ? Math.max(start, Math.min(selectionEnd, current.length))
      : start;
  const before = current.slice(0, start);
  const after = current.slice(end);
  const join =
    before !== "" &&
    insertion !== "" &&
    !/\s$/.test(before) &&
    !/^\s/.test(insertion)
      ? " "
      : "";
  const value = `${before}${join}${insertion}${after}`;
  return { value, caret: before.length + join.length + insertion.length };
}
