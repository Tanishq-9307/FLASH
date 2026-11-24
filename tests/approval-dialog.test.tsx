// @vitest-environment jsdom
// Approval dialog component tests (M3-21a, DESIGN.md §5.5/§8/§9).
// One test per state; keyboard reaches both buttons; HTML inside a
// parameter value is shown literally (never rendered as markup).
// Countdown helpers are unit-tested with a fixed server clock.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { act } from "react";

// React's act() needs the test environment flag for direct act() calls.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalDialog,
  formatCountdown,
  parameterRows,
  remainingMs,
  type ApprovalState,
  type ApprovalView,
} from "@/components/approvals/approval-dialog";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");

function approval(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    id: "00000000-0000-4000-8000-000000000042",
    toolName: "create_task",
    parameters: { title: "Buy milk", due_date: "2026-11-25" },
    expiresAt: new Date(NOW + 5 * 60 * 1000).toISOString(),
    serverNow: new Date(NOW).toISOString(),
    ...overrides,
  };
}

const handlers = {
  onApprove: vi.fn(),
  onCancel: vi.fn(),
  onClose: vi.fn(),
  onExpire: vi.fn(),
};

function renderDialog(state: ApprovalState, view: ApprovalView = approval(), extra: object = {}) {
  return render(
    <ApprovalDialog
      approval={view}
      state={state}
      {...handlers}
      now={() => NOW}
      {...extra}
    />,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("approval dialog helpers", () => {
  it("remainingMs corrects for a browser clock that disagrees with the server", () => {
    // Server says 12:00, browser clock says 12:02 (loadedAt is the
    // browser's Date.now at load); expiry 12:05 server time leaves 5 min.
    const loadedAt = NOW + 2 * 60 * 1000;
    expect(remainingMs(new Date(NOW + 5 * 60 * 1000).toISOString(), new Date(NOW).toISOString(), loadedAt, loadedAt)).toBe(5 * 60 * 1000);
  });

  it("remainingMs never goes below zero", () => {
    expect(remainingMs(new Date(NOW - 1000).toISOString(), new Date(NOW).toISOString(), NOW, NOW)).toBe(0);
  });

  it("formatCountdown renders minutes and zero-padded seconds", () => {
    expect(formatCountdown(5 * 60 * 1000)).toBe("5:00");
    expect(formatCountdown(65 * 1000)).toBe("1:05");
    expect(formatCountdown(0)).toBe("0:00");
  });

  it("parameterRows stringifies non-string values and nulls", () => {
    expect(parameterRows({ title: "x", due_date: null, n: 3 })).toEqual([
      { key: "title", value: "x" },
      { key: "due_date", value: "none" },
      { key: "n", value: "3" },
    ]);
    expect(parameterRows("plain")).toEqual([{ key: "value", value: '"plain"' }]);
  });
});

describe("approval dialog states", () => {
  it("active: shows the tool label, risk badge from the registry, plain-text parameters, and a timer", () => {
    renderDialog("active");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Create task")).toBeInTheDocument();
    expect(screen.getByText("create_task")).toBeInTheDocument();
    expect(screen.getByText("medium risk")).toBeInTheDocument();
    expect(screen.getByText("Buy milk")).toBeInTheDocument();
    expect(screen.getByText("2026-11-25")).toBeInTheDocument();
    const timer = screen.getByRole("timer");
    expect(timer).toHaveTextContent("Expires in 5:00");
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("active: unknown tool shows unknown risk, never a model-supplied level", () => {
    renderDialog("active", approval({ toolName: "do_anything" }));
    expect(screen.getByText("unknown risk")).toBeInTheDocument();
    expect(screen.getByText("Unknown action")).toBeInTheDocument();
  });

  it("executing: buttons disabled, Approve shows a spinner label", () => {
    renderDialog("executing");
    expect(screen.getByRole("button", { name: /Running/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("retryable: shows the error, attempts used, and a Try again button", () => {
    renderDialog("retryable", approval(), { attemptsUsed: 2, errorText: "The action failed." });
    expect(screen.getByRole("alert")).toHaveTextContent("Attempts used: 2 of 3");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("expired: shows Expired and only a Close button", () => {
    renderDialog("expired");
    expect(screen.getByText("Expired. Nothing was run.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("failed: shows the failure text as an alert", () => {
    renderDialog("failed");
    expect(screen.getByRole("alert")).toHaveTextContent("Failed. Nothing was changed");
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("succeeded: shows Done and only a Close button", () => {
    renderDialog("succeeded");
    expect(screen.getByText("Done. The database confirmed it.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("rejected: shows Cancelled and only a Close button", () => {
    renderDialog("rejected");
    expect(screen.getByText("Cancelled. Nothing was run.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});

describe("approval dialog literal text", () => {
  it("HTML inside a parameter value is shown literally, never rendered", () => {
    const hostile = '<img src="x" onerror="alert(1)">steal';
    renderDialog("active", approval({ parameters: { title: hostile } }));
    expect(screen.getByText(hostile)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("long values truncate with an expand control", () => {
    const long = "a".repeat(200);
    renderDialog("active", approval({ parameters: { title: long } }));
    expect(screen.getByText("Show all")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Show all"));
    expect(screen.getByText("Show less")).toBeInTheDocument();
    expect(screen.getByText(long)).toBeInTheDocument();
  });
});

describe("approval dialog keyboard and countdown", () => {
  it("keyboard reaches both buttons: Tab cycles between Cancel and Approve", () => {
    renderDialog("active");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const approve = screen.getByRole("button", { name: "Approve" });
    // Focus starts on the first button (Cancel) when the dialog opens.
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(approve);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
  });

  it("Escape asks what Cancel does instead of silently approving or closing", () => {
    renderDialog("active");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByText("Cancel this action? Nothing will run.")).toBeInTheDocument();
    expect(handlers.onCancel).not.toHaveBeenCalled();
    expect(handlers.onApprove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Yes, cancel it"));
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it("Cancel asks first; Keep it open dismisses the confirmation", () => {
    renderDialog("active");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Cancel this action? Nothing will run.")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Keep it open"));
    expect(screen.queryByText("Cancel this action? Nothing will run.")).toBeNull();
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });

  it("countdown turns red under 10 seconds", () => {
    renderDialog("active", approval({ expiresAt: new Date(NOW + 9 * 1000).toISOString() }));
    expect(screen.getByRole("timer")).toHaveClass("text-danger");
  });

  it("countdown hitting zero calls onExpire once", () => {
    // now() must track the (fake) clock, or the countdown never moves.
    const start = Date.now();
    render(
      <ApprovalDialog
        approval={approval({
          expiresAt: new Date(start + 1000).toISOString(),
          serverNow: new Date(start).toISOString(),
        })}
        state="active"
        {...handlers}
        now={() => Date.now()}
      />,
    );
    expect(handlers.onExpire).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(handlers.onExpire).toHaveBeenCalledTimes(1);
  });

  it("focus returns to the previously focused element on unmount", () => {
    const before = document.createElement("button");
    before.textContent = "before";
    document.body.appendChild(before);
    before.focus();
    const { unmount } = renderDialog("active");
    expect(document.activeElement).not.toBe(before);
    unmount();
    expect(document.activeElement).toBe(before);
    before.remove();
  });
});
