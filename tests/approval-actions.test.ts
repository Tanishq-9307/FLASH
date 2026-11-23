// M3-19: rejectAction / executeAction Server Actions.
// - Each result code maps to the right client result and resume flag.
// - Refused claims write an audit row via record_claim_failure.
// - tool_error increments the counter via record_execution_failure;
//   the third failure returns resume.
// - Unauthenticated and invalid calls are refused before any rpc.
// The Supabase clients are mocked; no network and no database.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUserRpc = vi.fn();
const mockAdminRpc = vi.fn();
const mockGetUser = vi.fn();

vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    rpc: mockUserRpc,
  })),
}));

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: mockAdminRpc }),
}));

import { executeAction, rejectAction } from "@/app/approvals/actions";

const USER = "00000000-0000-4000-8000-000000000001";
const ID = "00000000-0000-4000-8000-000000000042";

function asUser(): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: USER } }, error: null });
}

function asAnonymous(): void {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
}

describe("rejectAction (M3-19)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asUser();
  });

  it("rejects an open approval and tells the browser to resume", async () => {
    mockUserRpc.mockResolvedValue({
      data: [{ approval_id: ID, approval_status: "rejected" }],
      error: null,
    });
    const result = await rejectAction(ID);
    expect(result).toEqual({ ok: true, status: "rejected", resume: true });
    expect(mockUserRpc).toHaveBeenCalledTimes(1);
    expect(mockUserRpc).toHaveBeenCalledWith("reject_action", {
      p_approval_id: ID,
    });
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it("a missing or already-decided approval is not_found, still with resume", async () => {
    mockUserRpc.mockResolvedValue({ data: [], error: null });
    const result = await rejectAction(ID);
    expect(result).toEqual({ ok: false, error: "not_found", resume: true });
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it("an unauthenticated call is refused before any rpc", async () => {
    asAnonymous();
    const result = await rejectAction(ID);
    expect(result).toEqual({
      ok: false,
      error: "unauthenticated",
      resume: false,
    });
    expect(mockUserRpc).not.toHaveBeenCalled();
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it("an invalid id is refused before any rpc", async () => {
    const result = await rejectAction("not-a-uuid");
    expect(result).toEqual({ ok: false, error: "invalid", resume: false });
    expect(mockUserRpc).not.toHaveBeenCalled();
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });
});

describe("executeAction (M3-19)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asUser();
    mockUserRpc.mockImplementation(async (fn: string) => {
      if (fn === "approve_action") {
        return {
          data: [{ approval_id: ID, approval_status: "approved" }],
          error: null,
        };
      }
      if (fn === "execute_approved_action") {
        return {
          data: [{ result_code: "claimed", result_payload: {} }],
          error: null,
        };
      }
      throw new Error(`unexpected rpc ${fn}`);
    });
    mockAdminRpc.mockResolvedValue({ data: [], error: null });
  });

  it("a claimed execution succeeds and tells the browser to resume", async () => {
    const result = await executeAction(ID);
    expect(result).toEqual({ ok: true, status: "succeeded", resume: true });
    expect(mockUserRpc).toHaveBeenCalledWith("approve_action", {
      p_approval_id: ID,
    });
    expect(mockUserRpc).toHaveBeenCalledWith("execute_approved_action", {
      p_approval_id: ID,
    });
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it("a refused approve audits a claim failure and returns not_found with resume", async () => {
    mockUserRpc.mockImplementation(async (fn: string) => {
      if (fn === "approve_action") return { data: [], error: null };
      throw new Error(`unexpected rpc ${fn}`);
    });
    mockAdminRpc.mockResolvedValue({
      data: [{ audit_log_id: "00000000-0000-0000-0000-000000000043", resume: false }],
      error: null,
    });
    const result = await executeAction(ID);
    expect(result).toEqual({ ok: false, error: "not_found", resume: true });
    expect(mockAdminRpc).toHaveBeenCalledTimes(1);
    expect(mockAdminRpc).toHaveBeenCalledWith("record_claim_failure", {
      p_approval_id: ID,
      p_user_id: USER,
      p_reason: "not_approved",
      p_is_tamper: false,
    });
  });

  it("a tool_error increments the counter and returns retryable with the count", async () => {
    mockUserRpc.mockImplementation(async (fn: string) => {
      if (fn === "approve_action") {
        return {
          data: [{ approval_id: ID, approval_status: "approved" }],
          error: null,
        };
      }
      if (fn === "execute_approved_action") {
        return {
          data: [{ result_code: "tool_error", result_payload: {} }],
          error: null,
        };
      }
      throw new Error(`unexpected rpc ${fn}`);
    });
    mockAdminRpc.mockResolvedValue({
      data: [{ retry_count: 1, failed: false }],
      error: null,
    });
    const result = await executeAction(ID);
    expect(result).toEqual({
      ok: false,
      error: "tool_error",
      resume: false,
      retryCount: 1,
    });
    expect(mockAdminRpc).toHaveBeenCalledTimes(1);
    expect(mockAdminRpc).toHaveBeenCalledWith("record_execution_failure", {
      p_approval_id: ID,
      p_user_id: USER,
      p_error: { error: "tool_error" },
    });
  });

  it("a third tool_error fails the approval and returns resume", async () => {
    mockUserRpc.mockImplementation(async (fn: string) => {
      if (fn === "approve_action") {
        return {
          data: [{ approval_id: ID, approval_status: "approved" }],
          error: null,
        };
      }
      if (fn === "execute_approved_action") {
        return {
          data: [{ result_code: "tool_error", result_payload: {} }],
          error: null,
        };
      }
      throw new Error(`unexpected rpc ${fn}`);
    });
    mockAdminRpc.mockResolvedValue({
      data: [{ retry_count: 3, failed: true }],
      error: null,
    });
    const result = await executeAction(ID);
    expect(result).toEqual({ ok: true, status: "failed", resume: true });
  });

  it.each([
    ["replay", false],
    ["expired", false],
    ["hash_mismatch", true],
    ["exhausted", false],
    ["not_approved", false],
  ])(
    "a refused claim %s is audited with that reason and returns a generic error with resume",
    async (code, isTamper) => {
      mockUserRpc.mockImplementation(async (fn: string) => {
        if (fn === "approve_action") {
          return {
            data: [{ approval_id: ID, approval_status: "approved" }],
            error: null,
          };
        }
        if (fn === "execute_approved_action") {
          return {
            data: [{ result_code: code, result_payload: {} }],
            error: null,
          };
        }
        throw new Error(`unexpected rpc ${fn}`);
      });
      mockAdminRpc.mockResolvedValue({
        data: [
          {
            audit_log_id: "00000000-0000-0000-0000-000000000043",
            resume: code === "hash_mismatch",
          },
        ],
        error: null,
      });
      const result = await executeAction(ID);
      expect(result).toEqual({
        ok: false,
        error: "action_failed",
        resume: true,
      });
      expect(mockAdminRpc).toHaveBeenCalledTimes(1);
      expect(mockAdminRpc).toHaveBeenCalledWith("record_claim_failure", {
        p_approval_id: ID,
        p_user_id: USER,
        p_reason: code,
        p_is_tamper: isTamper,
      });
      // The specific claim code never reaches the browser.
      expect(JSON.stringify(result)).not.toContain(code);
    },
  );

  it("an unauthenticated call is refused before any rpc", async () => {
    asAnonymous();
    const result = await executeAction(ID);
    expect(result).toEqual({
      ok: false,
      error: "unauthenticated",
      resume: false,
    });
    expect(mockUserRpc).not.toHaveBeenCalled();
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });

  it("an invalid id is refused before any rpc", async () => {
    const result = await executeAction("not-a-uuid");
    expect(result).toEqual({ ok: false, error: "invalid", resume: false });
    expect(mockUserRpc).not.toHaveBeenCalled();
    expect(mockAdminRpc).not.toHaveBeenCalled();
  });
});
