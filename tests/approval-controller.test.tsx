// @vitest-environment jsdom
// Approval dialog wiring tests (M3-21b): integration tests with mocked
// Server Actions for success, retry, expiry, and cancel paths, plus the
// snapshot state mapping. No network and no database.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  ApprovalController,
  stateFromStatus,
  type ApprovalActions,
  type ApprovalSnapshotLike,
} from "@/components/approvals/approval-controller";

afterEach(() => cleanup());

const ID = "00000000-0000-4000-8000-000000000042";
const NOW = Date.now();

function snapshot(overrides: Partial<ApprovalSnapshotLike> = {}): ApprovalSnapshotLike {
  return {
    id: ID,
    toolName: "create_task",
    parameters: { title: "Buy milk" },
    status: "pending",
    retryCount: 0,
    expiresAt: new Date(NOW + 5 * 60 * 1000).toISOString(),
    serverNow: new Date(NOW).toISOString(),
    ...overrides,
  };
}

type MockActions = ApprovalActions & {
  getApproval: Mock;
  executeAction: Mock;
  rejectAction: Mock;
  resume: Mock;
};

function actions(overrides: Partial<MockActions> = {}): MockActions {
  return {
    getApproval: vi.fn(async () => ({ ok: true as const, data: snapshot() })),
    executeAction: vi.fn(async () => ({ ok: true as const, status: "succeeded" as const, resume: true })),
    rejectAction: vi.fn(async () => ({ ok: true as const, status: "rejected" as const, resume: true })),
    resume: vi.fn(async () => {}),
    ...overrides,
  };
}

function renderController(mock: MockActions) {
  const onResolved = vi.fn();
  const onClose = vi.fn();
  render(
    <ApprovalController approvalId={ID} actions={mock} onResolved={onResolved} onClose={onClose} />,
  );
  return { onResolved, onClose };
}

describe("stateFromStatus", () => {
  it("maps every stored status to a dialog state", () => {
    expect(stateFromStatus("pending", 0)).toBe("active");
    expect(stateFromStatus("approved", 0)).toBe("active");
    expect(stateFromStatus("approved", 1)).toBe("retryable");
    expect(stateFromStatus("consumed", 0)).toBe("succeeded");
    expect(stateFromStatus("rejected", 0)).toBe("rejected");
    expect(stateFromStatus("expired", 0)).toBe("expired");
    expect(stateFromStatus("failed", 0)).toBe("failed");
    expect(stateFromStatus("anything-else", 0)).toBe("failed");
  });
});

describe("ApprovalController", () => {
  it("success: approving runs the action, shows Done, resumes once, and resolves", async () => {
    const mock = actions();
    const { onResolved } = renderController(mock);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Buy milk")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Done. The database confirmed it.")).toBeInTheDocument();
    expect(mock.executeAction).toHaveBeenCalledWith(ID);
    expect(mock.resume).toHaveBeenCalledTimes(1);
    expect(mock.resume).toHaveBeenCalledWith(ID);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("retry: a tool_error shows the retryable state with attempts used and does not resume", async () => {
    const mock = actions({
      executeAction: vi.fn(async () => ({
        ok: false as const,
        error: "tool_error" as const,
        resume: false,
        retryCount: 1,
      })),
    });
    renderController(mock);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/Attempts used: 1 of 3/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(mock.resume).not.toHaveBeenCalled();
  });

  it("retry then success: Try again re-runs and reaches Done", async () => {
    const mock = actions({
      executeAction: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: "tool_error", resume: false, retryCount: 1 })
        .mockResolvedValueOnce({ ok: true, status: "succeeded", resume: true }),
    });
    renderController(mock);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/Attempts used: 1 of 3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Done. The database confirmed it.")).toBeInTheDocument();
    expect(mock.resume).toHaveBeenCalledTimes(1);
  });

  it("expiry: an already-expired countdown resumes and the dialog shows Expired", async () => {
    const expired = snapshot({
      expiresAt: new Date(NOW - 1000).toISOString(),
      status: "expired",
    });
    const mock = actions({
      getApproval: vi.fn(async () => ({ ok: true as const, data: expired })),
    });
    renderController(mock);
    // The countdown is already at zero, so the dialog expires on mount;
    // the controller delivers the outcome and re-reads the stored state.
    expect(await screen.findByText("Expired. Nothing was run.")).toBeInTheDocument();
    expect(mock.resume).toHaveBeenCalledTimes(1);
  });

  it("cancel: confirming Cancel rejects, shows Cancelled, resumes once, and resolves", async () => {
    const mock = actions();
    const { onResolved } = renderController(mock);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByText("Yes, cancel it"));
    expect(await screen.findByText("Cancelled. Nothing was run.")).toBeInTheDocument();
    expect(mock.rejectAction).toHaveBeenCalledWith(ID);
    expect(mock.resume).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("refused claim: approve with resume re-reads the stored final state and delivers", async () => {
    const mock = actions({
      executeAction: vi.fn(async () => ({ ok: false as const, error: "action_failed" as const, resume: true })),
      getApproval: vi
        .fn()
        .mockResolvedValueOnce({ ok: true as const, data: snapshot() })
        .mockResolvedValueOnce({ ok: true as const, data: snapshot({ status: "expired" }) }),
    });
    renderController(mock);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Expired. Nothing was run.")).toBeInTheDocument();
    expect(mock.resume).toHaveBeenCalledTimes(1);
  });

  it("load failure: a snapshot that cannot be read shows an alert and runs nothing", async () => {
    const mock = actions({
      getApproval: vi.fn(async () => ({ ok: false as const, error: "unavailable" })),
    });
    renderController(mock);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
    expect(mock.executeAction).not.toHaveBeenCalled();
    expect(mock.resume).not.toHaveBeenCalled();
  });

  it("already final on load: an expired approval is delivered without any click", async () => {
    const mock = actions({
      getApproval: vi.fn(async () => ({
        ok: true as const,
        data: snapshot({ status: "expired" }),
      })),
    });
    renderController(mock);
    expect(await screen.findByText("Expired. Nothing was run.")).toBeInTheDocument();
    expect(mock.resume).toHaveBeenCalledTimes(1);
  });
});
