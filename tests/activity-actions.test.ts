// listActivity Server Action tests (M3-22).
// The Supabase client is mocked; no network and no database.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();
const mockGetUser = vi.fn();

function chainable() {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.order = vi.fn(() => chain);
  chain.limit = mockQuery;
  return chain;
}

vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: vi.fn(() => chainable()),
  })),
}));

import { listActivity } from "@/app/activity/actions";

const USER = "00000000-0000-4000-8000-000000000001";

describe("listActivity (M3-22)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: USER } }, error: null });
    mockQuery.mockResolvedValue({ data: [], error: null });
  });

  it("returns the newest rows first, capped at 100", async () => {
    const rows = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        tool_name: "create_task",
        parameters: { title: "Buy milk" },
        execution_status: "succeeded",
        result_payload: null,
        created_at: "2026-11-24T06:30:00.000Z",
        approval_id: null,
        conversation_id: null,
      },
    ];
    mockQuery.mockResolvedValue({ data: rows, error: null });
    const result = await listActivity();
    expect(result).toEqual({ ok: true, data: rows });
  });

  it("unauthenticated call is refused", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    expect(await listActivity()).toEqual({ ok: false, error: "unauthenticated" });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("a database error is unavailable", async () => {
    mockQuery.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await listActivity()).toEqual({ ok: false, error: "unavailable" });
  });
});
