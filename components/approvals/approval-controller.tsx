// Approval dialog wiring (M3-21b, DESIGN.md §5.5, ARCHITECTURE.md
// §11.2). Loads the STORED snapshot by id, sends only the id to the
// Server Actions, shows the real result codes, and calls the resume
// route when a final state is reached or the countdown hits zero.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApprovalDialog,
  type ApprovalState,
  type ApprovalView,
} from "./approval-dialog";
import type { ApprovalActionResult } from "@/app/approvals/actions";

export type ApprovalSnapshotLike = ApprovalView & {
  status: string;
  retryCount: number;
};

export type ApprovalActions = {
  getApproval: (
    id: string,
  ) => Promise<
    | { ok: true; data: ApprovalSnapshotLike }
    | { ok: false; error: string }
  >;
  executeAction: (id: string) => Promise<ApprovalActionResult>;
  rejectAction: (id: string) => Promise<ApprovalActionResult>;
  /** POST /api/chat/resume with only the id; resolves when the server is done. */
  resume: (id: string) => Promise<void>;
};

/** The dialog state for a stored approval status. */
export function stateFromStatus(status: string, retryCount: number): ApprovalState {
  switch (status) {
    case "pending":
      return "active";
    case "approved":
      return retryCount > 0 ? "retryable" : "active";
    case "consumed":
      return "succeeded";
    case "rejected":
      return "rejected";
    case "expired":
      return "expired";
    default:
      return "failed";
  }
}

const FINAL: ApprovalState[] = ["succeeded", "failed", "expired", "rejected"];
const UNAVAILABLE = "Could not reach the server. Nothing was confirmed; try again.";

/** Calls the resume route; a JSON answer (nothing to do) or a stream both end here. */
export async function resumeApproval(id: string): Promise<void> {
  const res = await fetch("/api/chat/resume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approval_id: id }),
  });
  await res.text();
}

export function ApprovalController({
  approvalId,
  actions,
  onResolved,
  onClose,
}: {
  approvalId: string;
  actions: ApprovalActions;
  /** Called after the outcome was delivered, so the chat reloads stored messages. */
  onResolved: () => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<ApprovalView | null>(null);
  const [state, setState] = useState<ApprovalState>("active");
  const [attemptsUsed, setAttemptsUsed] = useState<number | undefined>();
  const [errorText, setErrorText] = useState<string | undefined>();
  const [loadError, setLoadError] = useState(false);

  // The latest callback, without re-running effects when the parent re-renders.
  const onResolvedRef = useRef(onResolved);
  useEffect(() => {
    onResolvedRef.current = onResolved;
  }, [onResolved]);
  // Each outcome is delivered once from this dialog (the server also allows it only once).
  const delivered = useRef(false);

  const deliver = useCallback(async () => {
    if (delivered.current) return;
    delivered.current = true;
    try {
      await actions.resume(approvalId);
    } finally {
      onResolvedRef.current();
    }
  }, [actions, approvalId]);

  /** Re-reads the stored status (after a refusal or expiry) and shows it. */
  const refresh = useCallback(async () => {
    const snap = await actions.getApproval(approvalId);
    if (!snap.ok) {
      setLoadError(true);
      return null;
    }
    setView(snap.data);
    const next = stateFromStatus(snap.data.status, snap.data.retryCount);
    setState(next);
    if (snap.data.retryCount > 0) setAttemptsUsed(snap.data.retryCount);
    return next;
  }, [actions, approvalId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await refresh();
      // Already final (for example the page closed before Resume): deliver it now.
      if (!cancelled && next && FINAL.includes(next)) void deliver();
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh, deliver]);

  async function approve() {
    setErrorText(undefined);
    setState("executing");
    const result = await actions.executeAction(approvalId);
    if (!result.ok) {
      if (result.error === "tool_error" && result.retryCount !== undefined) {
        // Retryable: the write rolled back, the approval is still
        // approved, and the counter says how many attempts are used.
        setAttemptsUsed(result.retryCount);
        setState("retryable");
        setErrorText("The action failed.");
        return;
      }
      if (result.resume) {
        // A refused claim or an expired approval: the final state is
        // in the database — show it, then deliver the outcome.
        await refresh();
        await deliver();
        return;
      }
      setState("active");
      setErrorText(UNAVAILABLE);
      return;
    }
    setState(result.status);
    if (result.resume) await deliver();
  }

  async function cancel() {
    setErrorText(undefined);
    const result = await actions.rejectAction(approvalId);
    if (!result.ok) {
      if (result.resume) {
        await refresh();
        await deliver();
        return;
      }
      setErrorText(UNAVAILABLE);
      return;
    }
    setState(result.status);
    if (result.resume) await deliver();
  }

  async function expire() {
    // The server expires it (expire_stale_approval in the resume
    // route) and delivers the outcome.
    await deliver();
    await refresh();
  }

  if (loadError && !view) {
    return (
      <p role="alert" className="mx-auto my-3 max-w-3xl text-center text-sm text-danger">
        The pending action could not be loaded. Nothing was run. Reload to try again.
      </p>
    );
  }
  if (!view) return null;
  return (
    <ApprovalDialog
      approval={view}
      state={state}
      attemptsUsed={attemptsUsed}
      errorText={errorText}
      onApprove={() => void approve()}
      onCancel={() => void cancel()}
      onClose={onClose}
      onExpire={() => void expire()}
    />
  );
}
