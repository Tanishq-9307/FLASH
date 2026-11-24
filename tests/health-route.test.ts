// GET /api/health tests (usage meters, owner decision 2026-11-24):
// the response always says "online" when the check works (no
// limit_reached any more), today's model usage with the configured
// daily limit, and this calendar month's search count with the
// monthly limit. The Supabase client is mocked; no network, no DB.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.fn();
let apiUsageRow: { model_calls: number } | null = null;
let searchRows: Array<{ searches: number; usage_date: string }> = [];

function chainable(table: string) {
  const chain: Record<string, unknown> = {};
  let gteDate: string | null = null;
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.gte = vi.fn((_col: string, value: string) => {
    gteDate = value;
    return chain;
  });
  chain.maybeSingle = vi.fn(async () => ({
    data: table === "api_usage" ? apiUsageRow : null,
    error: null,
  }));
  // The search_usage read ends in .gte(...) and is awaited directly.
  // The mock applies the date filter, like the real query.
  chain.then = (resolve: (value: unknown) => void, reject?: (reason: unknown) => void) => {
    // gteDate is set by .gte() before the chain is awaited, so read it
    // here rather than at chain creation time.
    const filterDate = gteDate;
    return Promise.resolve({
      data:
        filterDate === null
          ? searchRows
          : searchRows.filter((row) => row.usage_date >= filterDate),
      error: null,
    }).then(resolve, reject);
  };
  return chain;
}

vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: vi.fn((table: string) => chainable(table)),
  })),
}));

import { GET } from "@/app/api/health/route";
import { usageMonthStart } from "@/lib/config";

const USER = "00000000-0000-4000-8000-000000000001";

describe("GET /api/health (usage meters)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: USER } }, error: null });
    apiUsageRow = { model_calls: 3 };
    searchRows = [
      { searches: 40, usage_date: usageMonthStart() },
      { searches: 10, usage_date: usageMonthStart() },
      // Last month's rows must not count toward this month's meter.
      { searches: 900, usage_date: "2020-01-15" },
    ];
    delete process.env.DAILY_MODEL_CALL_CAP;
    delete process.env.MONTHLY_SEARCH_CAP;
  });

  it("returns online with today's model usage and this month's search usage", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("online");
    expect(body.usage).toBe(3);
    expect(body.cap).toBe(1000);
    expect(body.searchUsage).toBe(50);
    expect(body.searchCap).toBe(1000);
  });

  it("never reports limit_reached, even past the configured limit", async () => {
    apiUsageRow = { model_calls: 500 };
    const body = await (await GET()).json();
    expect(body.status).toBe("online");
    expect(body.usage).toBe(500);
  });

  it("no usage rows means zero usage, not Unavailable", async () => {
    apiUsageRow = null;
    searchRows = [];
    const body = await (await GET()).json();
    expect(body.usage).toBe(0);
    expect(body.searchUsage).toBe(0);
  });

  it("unauthenticated callers get 401", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await GET();
    expect(res.status).toBe(401);
  });
});
