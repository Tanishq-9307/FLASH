// listOpenApprovals tests (M3-24b).
// The Supabase client is mocked; no network and no database.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSelect = vi.fn();
const mockGetUser = vi.fn();

function chainable() {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.order = mockSelect;
  chain.then = (resolve: (value: unknown) => void, reject?: (reason: unknown) => void) =>
    mockSelect().then(resolve, reject);
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

import { listOpenApprovals } from "@/app/approvals/actions";

const USER = "00000000-0000-4000-8000-000000000001";
const ROW = {
  id: "00000000-0000-4000-8000-000000000042",
  tool_name: "create_task",
  conversation_id: "00000000-0000-4000-8000-000000000002",
  created_at: "2026-11-24T06:30:00.000Z",
  expires_at: "2026-11-24T06:35:00.000Z",
};

describe("listOpenApprovals (M3-24b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: USER } }, error: null });
    mockSelect.mockResolvedValue({ data: [ROW], error: null });
  });

  it("returns the owner's pending approvals, oldest first", async () => {
    expect(await listOpenApprovals()).toEqual({
      ok: true,
      data: [
        {
          id: ROW.id,
          toolName: "create_task",
          conversationId: ROW.conversation_id,
          createdAt: ROW.created_at,
          expiresAt: ROW.expires_at,
        },
      ],
    });
  });

  it("an empty list means no approval is open", async () => {
    mockSelect.mockResolvedValue({ data: [], error: null });
    expect(await listOpenApprovals()).toEqual({ ok: true, data: [] });
  });

  it("a database error is unavailable, never an empty list", async () => {
    mockSelect.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await listOpenApprovals()).toEqual({ ok: false, error: "unavailable" });
  });

  it("unauthenticated calls are refused before any database call", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    expect(await listOpenApprovals()).toEqual({ ok: false, error: "unauthenticated" });
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
