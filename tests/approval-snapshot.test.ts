// getApprovalSnapshot Server Action tests (M3-21b).
// The Supabase clients are mocked; no network and no database.
// The snapshot is a user-scoped select of the stored approval row.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMaybeSingle = vi.fn();
const mockGetUser = vi.fn();

function chainable() {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.maybeSingle = mockMaybeSingle;
  return chain;
}

vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: vi.fn(() => chainable()),
  })),
}));

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({ rpc: vi.fn() })),
}));

import { getApprovalSnapshot } from "@/app/approvals/actions";

const USER = "00000000-0000-4000-8000-000000000001";
const ID = "00000000-0000-4000-8000-000000000042";

function asUser(): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: USER } }, error: null });
}

function asAnonymous(): void {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
}

const ROW = {
  id: ID,
  tool_name: "create_task",
  parameters: { title: "Buy milk" },
  status: "pending",
  retry_count: 0,
  expires_at: "2026-11-24T12:05:00.000Z",
};

describe("getApprovalSnapshot (M3-21b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asUser();
    mockMaybeSingle.mockResolvedValue({ data: ROW, error: null });
  });

  it("returns the stored snapshot with the server clock", async () => {
    const result = await getApprovalSnapshot(ID);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.toolName).toBe("create_task");
    expect(result.data.parameters).toEqual({ title: "Buy milk" });
    expect(result.data.status).toBe("pending");
    expect(result.data.retryCount).toBe(0);
    expect(result.data.expiresAt).toBe("2026-11-24T12:05:00.000Z");
    expect(Date.parse(result.data.serverNow)).not.toBeNaN();
  });

  it("invalid id is refused before any database call", async () => {
    const result = await getApprovalSnapshot("not-a-uuid");
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(mockMaybeSingle).not.toHaveBeenCalled();
  });

  it("unauthenticated call is refused", async () => {
    asAnonymous();
    const result = await getApprovalSnapshot(ID);
    expect(result).toEqual({ ok: false, error: "unauthenticated" });
  });

  it("a missing or foreign approval is not_found", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const result = await getApprovalSnapshot(ID);
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("a database error is unavailable", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    const result = await getApprovalSnapshot(ID);
    expect(result).toEqual({ ok: false, error: "unavailable" });
  });
});
