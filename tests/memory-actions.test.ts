// Memory Server Action tests (M3-23).
// The Supabase client is mocked; no network and no database.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSingle = vi.fn();
const mockSelect = vi.fn();
const mockGetUser = vi.fn();

function chainable() {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.order = vi.fn(() => chain);
  chain.limit = mockSelect;
  chain.update = vi.fn(() => chain);
  chain.delete = vi.fn(() => chain);
  chain.upsert = vi.fn(() => chain);
  chain.single = mockSingle;
  chain.maybeSingle = mockSingle;
  // The delete path ends in .select("id") and awaits the chain itself,
  // so the chain must be thenable like a real query builder.
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

import {
  deleteMemory,
  getMemoryEnabled,
  listMemories,
  setMemoryEnabled,
  updateMemory,
} from "@/app/memory/actions";

const USER = "00000000-0000-4000-8000-000000000001";
const ID = "00000000-0000-4000-8000-000000000042";

const ROW = {
  id: ID,
  fact: "Prefers strong coffee.",
  created_at: "2026-11-24T06:30:00.000Z",
  updated_at: "2026-11-24T06:30:00.000Z",
};

function asUser(): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: USER } }, error: null });
}

describe("memory actions (M3-23)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asUser();
    mockSelect.mockResolvedValue({ data: [ROW], error: null });
    mockSingle.mockResolvedValue({ data: ROW, error: null });
  });

  it("listMemories returns the newest memories", async () => {
    expect(await listMemories()).toEqual({ ok: true, data: [ROW] });
  });

  it("updateMemory trims the fact and returns the committed row", async () => {
    const result = await updateMemory(ID, "  Prefers strong coffee.  ");
    expect(result).toEqual({ ok: true, data: ROW });
  });

  it("updateMemory rejects an empty fact", async () => {
    expect(await updateMemory(ID, "   ")).toEqual({ ok: false, error: "invalid" });
    expect(mockSingle).not.toHaveBeenCalled();
  });

  it("updateMemory rejects a fact over 10,000 characters", async () => {
    expect(await updateMemory(ID, "x".repeat(10_001))).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(mockSingle).not.toHaveBeenCalled();
  });

  it("updateMemory maps a missing row to not_found", async () => {
    mockSingle.mockResolvedValue({ data: null, error: { message: "no rows" } });
    expect(await updateMemory(ID, "New fact.")).toEqual({ ok: false, error: "not_found" });
  });

  it("deleteMemory returns the deleted id", async () => {
    mockSelect.mockResolvedValue({ data: [{ id: ID }], error: null });
    expect(await deleteMemory(ID)).toEqual({ ok: true, data: { id: ID } });
  });

  it("deleteMemory rejects a bad id before any database call", async () => {
    expect(await deleteMemory("not-a-uuid")).toEqual({ ok: false, error: "invalid" });
  });

  it("getMemoryEnabled returns true when there is no settings row (the default)", async () => {
    mockSingle.mockResolvedValue({ data: null, error: null });
    expect(await getMemoryEnabled()).toEqual({ ok: true, data: true });
  });

  it("getMemoryEnabled returns the stored value when the row exists", async () => {
    mockSingle.mockResolvedValue({ data: { memory_enabled: false }, error: null });
    expect(await getMemoryEnabled()).toEqual({ ok: true, data: false });
  });

  it("setMemoryEnabled upserts and returns the saved value", async () => {
    mockSingle.mockResolvedValue({ data: { memory_enabled: false }, error: null });
    expect(await setMemoryEnabled(false)).toEqual({ ok: true, data: false });
  });

  it("unauthenticated calls are refused before any database call", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    expect(await listMemories()).toEqual({ ok: false, error: "unauthenticated" });
    expect(await getMemoryEnabled()).toEqual({ ok: false, error: "unauthenticated" });
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
