// M2-7: conversation Server Actions.
// - list/rename/delete call getUser() first; unauthenticated is refused
//   before any query.
// - Every query filters by the caller's user_id as well as the row id,
//   so a foreign id can never match even if RLS were misconfigured.
// - Titles are validated against the same 255-char DB CHECK (empty
//   rejected too — the CHECK alone would allow an empty title).
// - A missing row is not_found (missing and foreign are identical).
// - A delete refused by the M3 open-approval guard maps to open_approval.
// The Supabase client is mocked; no network and no database.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}));

import {
  deleteConversation,
  listConversations,
  renameConversation,
} from "@/app/chat/actions";

const USER = "00000000-0000-4000-8000-000000000001";
const ID = "00000000-0000-4000-8000-000000000042";
const OTHER_ID = "00000000-0000-4000-8000-000000000043";

type QueryResult = {
  data: unknown;
  error: { message: string } | null;
};

function asUser(): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: USER } }, error: null });
}

function asAnonymous(): void {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
}

/** A thenable fake of the Supabase query builder; records every call. */
function fakeQuery(result: QueryResult, calls: string[]) {
  const q: Record<string, unknown> = {
    select: (...args: unknown[]) => {
      calls.push(`select:${JSON.stringify(args)}`);
      return q;
    },
    eq: (...args: unknown[]) => {
      calls.push(`eq:${JSON.stringify(args)}`);
      return q;
    },
    order: (...args: unknown[]) => {
      calls.push(`order:${JSON.stringify(args)}`);
      return q;
    },
    update: (...args: unknown[]) => {
      calls.push(`update:${JSON.stringify(args)}`);
      return q;
    },
    delete: () => {
      calls.push("delete");
      return q;
    },
    single: () => Promise.resolve(result),
    then: (resolve: (value: QueryResult) => void) => resolve(result),
  };
  return q;
}

describe("listConversations (M2-7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asUser();
  });

  it("returns the caller's rows newest first", async () => {
    const calls: string[] = [];
    const rows = [
      { id: ID, title: "Second", updated_at: "2026-11-24T10:00:00Z" },
      { id: OTHER_ID, title: "First", updated_at: "2026-11-24T09:00:00Z" },
    ];
    mockFrom.mockReturnValue(fakeQuery({ data: rows, error: null }, calls));
    const result = await listConversations();
    expect(result).toEqual({ ok: true, data: rows });
    expect(mockFrom).toHaveBeenCalledWith("conversations");
    expect(calls).toContain(`eq:["user_id","${USER}"]`);
    expect(calls).toContain(`order:["updated_at",{"ascending":false}]`);
  });

  it("an unauthenticated call is refused before any query", async () => {
    asAnonymous();
    const result = await listConversations();
    expect(result).toEqual({ ok: false, error: "unauthenticated" });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("a database error is unavailable", async () => {
    mockFrom.mockReturnValue(
      fakeQuery({ data: null, error: { message: "boom" } }, []),
    );
    const result = await listConversations();
    expect(result).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("renameConversation (M2-7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asUser();
  });

  it("renames the caller's row and trims the title", async () => {
    const calls: string[] = [];
    const row = { id: ID, title: "Renamed", updated_at: "2026-11-24T10:00:00Z" };
    mockFrom.mockReturnValue(fakeQuery({ data: row, error: null }, calls));
    const result = await renameConversation(ID, "  Renamed  ");
    expect(result).toEqual({ ok: true, data: row });
    expect(calls).toContain(`update:[{"title":"Renamed"}]`);
    expect(calls).toContain(`eq:["id","${ID}"]`);
    expect(calls).toContain(`eq:["user_id","${USER}"]`);
  });

  it.each([[""], ["   "], ["x".repeat(256)]])(
    "a title of %p is invalid before any query",
    async (title) => {
      const result = await renameConversation(ID, title as string);
      expect(result).toEqual({ ok: false, error: "invalid" });
      expect(mockFrom).not.toHaveBeenCalled();
    },
  );

  it("an invalid id is refused before any query", async () => {
    const result = await renameConversation("not-a-uuid", "Title");
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("an unauthenticated call is refused before any query", async () => {
    asAnonymous();
    const result = await renameConversation(ID, "Title");
    expect(result).toEqual({ ok: false, error: "unauthenticated" });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("a missing or foreign row is not_found", async () => {
    mockFrom.mockReturnValue(
      fakeQuery(
        { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } },
        [],
      ),
    );
    const result = await renameConversation(OTHER_ID, "Title");
    expect(result).toEqual({ ok: false, error: "not_found" });
  });
});

describe("deleteConversation (M2-7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asUser();
  });

  it("deletes the caller's row", async () => {
    const calls: string[] = [];
    mockFrom.mockReturnValue(
      fakeQuery({ data: [{ id: ID }], error: null }, calls),
    );
    const result = await deleteConversation(ID);
    expect(result).toEqual({ ok: true, data: { id: ID } });
    expect(calls).toContain("delete");
    expect(calls).toContain(`eq:["id","${ID}"]`);
    expect(calls).toContain(`eq:["user_id","${USER}"]`);
  });

  it("a row blocked by an open approval maps to open_approval", async () => {
    mockFrom.mockReturnValue(
      fakeQuery(
        {
          data: null,
          error: { message: "conversation_has_open_approval" },
        },
        [],
      ),
    );
    const result = await deleteConversation(ID);
    expect(result).toEqual({ ok: false, error: "open_approval" });
  });

  it("a missing or foreign row is not_found", async () => {
    mockFrom.mockReturnValue(fakeQuery({ data: [], error: null }, []));
    const result = await deleteConversation(OTHER_ID);
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("another database error is unavailable", async () => {
    mockFrom.mockReturnValue(
      fakeQuery({ data: null, error: { message: "boom" } }, []),
    );
    const result = await deleteConversation(ID);
    expect(result).toEqual({ ok: false, error: "unavailable" });
  });

  it("an invalid id is refused before any query", async () => {
    const result = await deleteConversation("not-a-uuid");
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("an unauthenticated call is refused before any query", async () => {
    asAnonymous();
    const result = await deleteConversation(ID);
    expect(result).toEqual({ ok: false, error: "unauthenticated" });
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
