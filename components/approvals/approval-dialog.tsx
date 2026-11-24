// The approval dialog (M3-21a, DESIGN.md §5.5, §8, §9). Props-driven:
// it shows only what it is given, which is the parameter snapshot STORED
// in the database (never the model's words). Values are plain text in
// JetBrains Mono — React escapes them, so HTML inside a parameter value
// is shown literally and can never become markup. The countdown uses the
// server's expires_at, corrected by the server's "now", so a wrong
// browser clock cannot stretch or shorten it. Risk comes from the tool
// registry (lib/tools/registry.ts), never from the model.
"use client";

import { useEffect, useRef, useState } from "react";
import { getTool, type ToolRisk } from "@/lib/tools/registry";

export type ApprovalState =
  | "active"
  | "executing"
  | "retryable"
  | "expired"
  | "failed"
  | "succeeded"
  | "rejected";

export type ApprovalView = {
  id: string;
  toolName: string;
  parameters: unknown;
  expiresAt: string;
  /** The server's clock when the snapshot was read. */
  serverNow: string;
};

const LONG_VALUE = 120;

/** Milliseconds left, using the server's clock (offset measured once, when loaded). */
export function remainingMs(
  expiresAt: string,
  serverNow: string,
  loadedAt: number,
  now: number,
): number {
  const offset = Date.parse(serverNow) - loadedAt;
  return Math.max(0, Date.parse(expiresAt) - (now + offset));
}

export function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Key-value rows from the stored snapshot, as plain strings. */
export function parameterRows(parameters: unknown): { key: string; value: string }[] {
  if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
    return [{ key: "value", value: JSON.stringify(parameters) }];
  }
  return Object.entries(parameters as Record<string, unknown>).map(([key, value]) => ({
    key,
    value: value === null ? "none" : typeof value === "string" ? value : JSON.stringify(value),
  }));
}

const RISK_STYLE: Record<ToolRisk, string> = {
  low: "border-success text-success",
  medium: "border-warning text-warning",
  high: "border-danger text-danger",
};

const STATE_TEXT: Partial<Record<ApprovalState, string>> = {
  expired: "Expired. Nothing was run.",
  failed: "Failed. Nothing was changed, and it will not be tried again.",
  succeeded: "Done. The database confirmed it.",
  rejected: "Cancelled. Nothing was run.",
};

function ParamValue({ value }: { value: string }) {
  const [open, setOpen] = useState(false);
  if (value.length <= LONG_VALUE) return <span className="break-words">{value}</span>;
  return (
    <span className="break-words">
      {open ? value : `${value.slice(0, LONG_VALUE)}…`}{" "}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="min-h-11 px-1 font-sans text-xs text-accent-cyan underline"
      >
        {open ? "Show less" : "Show all"}
      </button>
    </span>
  );
}

export function ApprovalDialog({
  approval,
  state,
  attemptsUsed,
  errorText,
  onApprove,
  onCancel,
  onClose,
  onExpire,
  now = () => Date.now(),
}: {
  approval: ApprovalView;
  state: ApprovalState;
  attemptsUsed?: number;
  errorText?: string;
  onApprove: () => void;
  onCancel: () => void;
  onClose: () => void;
  /** Called once when the countdown reaches zero while the dialog is open for a decision. */
  onExpire: () => void;
  now?: () => number;
}) {
  const info = getTool(approval.toolName);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [loadedAt] = useState(() => now());
  const [left, setLeft] = useState(() =>
    remainingMs(approval.expiresAt, approval.serverNow, loadedAt, loadedAt),
  );
  const [confirmCancel, setConfirmCancel] = useState(false);
  const expiredFired = useRef(false);
  const deciding = state === "active" || state === "retryable" || state === "executing";
  const final = !deciding;

  // Countdown (only while a decision is still possible).
  useEffect(() => {
    if (!deciding) return;
    const tick = () => {
      const ms = remainingMs(approval.expiresAt, approval.serverNow, loadedAt, now());
      setLeft(ms);
      if (ms <= 0 && !expiredFired.current && state !== "executing") {
        expiredFired.current = true;
        onExpire();
      }
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [approval.expiresAt, approval.serverNow, loadedAt, now, deciding, state, onExpire]);

  // Focus: move in on open, give it back on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = dialogRef.current?.querySelector<HTMLElement>("button:not([disabled])");
    (first ?? dialogRef.current)?.focus();
    return () => previous?.focus?.();
    // Runs once on mount: the dialog opens once, and focus return must
    // capture the element that was focused before it opened.
  }, []);

  // Keyboard handling on the document, so Esc and Tab still work when
  // focus was lost (for example the Approve button became disabled
  // while running).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        // Esc never approves; it asks first what Cancel does.
        if (final) onClose();
        else if (state !== "executing") setConfirmCancel(true);
        return;
      }
      if (event.key !== "Tab") return;
      // The trap owns Tab order outright (rather than relying on the
      // browser's native move): forward goes to the next button and
      // wraps from the last back to the first; Shift+Tab reverses it.
      // That keeps focus inside even when it started outside.
      const items = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []),
      ];
      if (items.length === 0) return;
      event.preventDefault();
      const idx = items.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey) {
        items[idx <= 0 ? items.length - 1 : idx - 1].focus();
      } else {
        items[idx === -1 || idx === items.length - 1 ? 0 : idx + 1].focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [final, state, onClose]);

  const locked = left <= 0 && state !== "executing";
  const rows = parameterRows(approval.parameters);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        aria-describedby="approval-desc"
        tabIndex={-1}
        className="w-full max-w-lg rounded-md border border-border-strong bg-surface p-5 shadow-xl"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="approval-title" className="font-display text-lg font-semibold text-text-primary">
            {info?.displayLabel ?? "Unknown action"}{" "}
            <span className="font-mono text-sm text-text-secondary">{approval.toolName}</span>
          </h2>
          <span
            className={`rounded-full border px-2 py-0.5 font-display text-sm font-semibold tracking-[0.08em] uppercase ${
              info ? RISK_STYLE[info.risk] : RISK_STYLE.high
            }`}
          >
            {info ? `${info.risk} risk` : "unknown risk"}
          </span>
        </div>
        <p id="approval-desc" className="mt-1 text-sm text-text-secondary">
          FLASH wants to do this. Nothing runs unless you approve.
        </p>

        <dl className="mt-4 space-y-2 rounded-md bg-surface-raised p-3 font-mono text-sm">
          {rows.map((row) => (
            <div key={row.key} className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-3">
              <dt className="text-text-secondary">{row.key}</dt>
              <dd className="text-text-primary">
                <ParamValue value={row.value} />
              </dd>
            </div>
          ))}
        </dl>

        {deciding ? (
          <p
            role="timer"
            aria-live="off"
            aria-label={`Time left to decide: ${formatCountdown(left)}`}
            className={`mt-3 font-mono text-sm ${left < 10_000 ? "text-danger" : "text-text-secondary"}`}
          >
            Expires in {formatCountdown(left)}
          </p>
        ) : null}

        {state === "active" && errorText ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {errorText}
          </p>
        ) : null}
        {state === "retryable" ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {errorText ?? "The action failed."} Attempts used: {attemptsUsed ?? 1} of 3. You can
            try again.
          </p>
        ) : null}
        {final ? (
          <p
            role={state === "failed" ? "alert" : "status"}
            className={`mt-3 text-sm ${state === "succeeded" ? "text-success" : state === "failed" ? "text-danger" : "text-text-secondary"}`}
          >
            {STATE_TEXT[state]}
          </p>
        ) : null}

        {confirmCancel && deciding ? (
          <div role="alert" className="mt-3 rounded-md border border-border p-3 text-sm">
            <p>Cancel this action? Nothing will run.</p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmCancel(false)}
                className="min-h-11 rounded-md border border-border-strong px-3"
              >
                Keep it open
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmCancel(false);
                  onCancel();
                }}
                className="min-h-11 rounded-md border border-danger px-3 text-danger"
              >
                Yes, cancel it
              </button>
            </div>
          </div>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          {final ? (
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 rounded-md border border-border-strong px-4 text-text-primary"
            >
              Close
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setConfirmCancel(true)}
                disabled={state === "executing" || locked}
                className="min-h-11 rounded-md border border-border-strong px-4 text-text-primary disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onApprove}
                disabled={state === "executing" || locked}
                className="flex min-h-11 items-center gap-2 rounded-md bg-accent-cyan px-4 font-medium text-on-accent disabled:opacity-50"
              >
                {state === "executing" ? (
                  <span
                    aria-hidden="true"
                    className="inline-block size-4 animate-spin rounded-full border-2 border-on-accent/30 border-t-on-accent"
                  />
                ) : null}
                {state === "executing" ? "Running…" : state === "retryable" ? "Try again" : "Approve"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
