// M2-8b: note Server Actions.
// - Every action calls getUser() first; unauthenticated is refused
//   before any query.
// - Every query filters by the caller's user_id (insert writes it),
//   so a foreign id can never match even if RLS were misconfigured.
// - Titles and content are validated against the same limits as the
//   DB CHECKs (title 1–255, content <= 100,000); search queries are
//   1–200 characters.
// - Search calls textSearch on the `search` column with config
//   "english" and type "websearch" — the same expression as the GIN
//   index (to_tsvector('english', title || ' ' || content)); the
//   index-use proof itself lives in tests/db/tasks-notes.test.ts (M2-3).
// - A missing row is not_found (missing and foreign are identical).
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
  createNote,
  deleteNote,
  editNote,
  listNotes,
  searchNotes,
} from "@/app/tasks/note-actions";

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
    limit: (...args: unknown[]) => {
      calls.push(`limit:${JSON.stringify(args)}`);
      return q;
    },
    textSearch: (...args: unknown[]) => {
      calls.push(`textSearch:${JSON.stringify(args)}`);
      return q;
    },
    insert: (...args: unknown[]) => {
      calls.push(`insert:${JSON.stringify(args)}`);
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

const ROW = {
  id: ID,
  title: "Kinematics notes",
  content: "Forward kinematics maps joint angles to end-effector pose.",
  created_at: "2026-11-24T09:00:00Z",
  updated_at: "2026-11-24T09:00:00Z",
};

describe("listNotes (M2-8b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asUser();
  });

  it("returns the caller's rows newest first", async () => {
    const calls: string[] = [];
    mockFrom.mockReturnValue(fakeQuery({ data: [ROW], error: null }, calls));
    const result = await listNotes();
    expect(result).toEqual({ ok: true, data: [ROW] });
    expect(mockFrom).toHaveBeenCalledWith("notes");
    expect(calls).toContain(`eq:["user_id","${USER}"]`);
    expect(calls).toContain(`order:["updated_at",{"ascending":false}]`);
  });

  it("an unauthenticated call is refused before any query", async () => {
    asAnonymous();
    const result = await listNotes();
    expect(result).toEqual({ ok: false, error: "unauthenticated" });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("a database error is unavailable", async () => {
    mockFrom.mockReturnValue(
      fakeQuery({ data: null, error: { message: "boom" } }, []),
    );
    const result = await listNotes();
    expect(result).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("searchNotes (M2-8b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asUser();
  });

  it("searches the indexed search column with the english websearch query", async () => {
    const calls: string[] = [];
    mockFrom.mockReturnValue(fakeQuery({ data: [ROW], error: null }, calls));
    const result = await searchNotes("kinematics");
    expect(result).toEqual({ ok: true, data: [ROW] });
    expect(calls).toContain(`eq:["user_id","${USER}"]`);
    expect(calls).toContain(
      `textSearch:["search","kinematics",{"config":"english","type":"websearch"}]`,
    );
  });

  it("trims the query before searching", async () => {
    const calls: string[] = [];
    mockFrom.mockReturnValue(fakeQuery({ data: [], error: null }, calls));
    const result = await searchNotes("  kinematics  ");
    expect(result).toEqual({ ok: true, data: [] });
    expect(calls).toContain(
      `textSearch:["search","kinematics",{"config":"english","type":"websearch"}]`,
    );
  });

  it.each([[""], ["   "], ["x".repeat(201)]])(
    "an invalid query %p is refused before any query",
    async (query) => {
      const result = await searchNotes(query as string);
      expect(result).toEqual({ ok: false, error: "invalid" });
      expect(mockFrom).not.toHaveBeenCalled();
    },
  );

  it("an unauthenticated call is refused before any query", async () => {
    asAnonymous();
    const result = await searchNotes("kinematics");
    expect(result).toEqual({ ok: false, error: "unauthenticated" });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("a database error is unavailable", async () => {
    mockFrom.mockReturnValue(
      fakeQuery({ data: null, error: { message: "boom" } }, []),
    );
    const result = await searchNotes("kinematics");
    expect(result).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("createNote (M2-8b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asUser();
  });

  it("creates the row with a trimmed title", async () => {
    const calls: string[] = [];
    mockFrom.mockReturnValue(fakeQuery({ data: ROW, error: null }, calls));
    const result = await createNote({
      title: "  Kinematics  notes ",
      content: ROW.content,
    });
    expect(result).toEqual({ ok: true, data: ROW });
    expect(calls).toContain(
      `insert:[{"title":"Kinematics notes","content":"${ROW.content}","user_id":"${USER}"}]`,
    );
  });

  it.each([
    [{ title: "", content: "x" }],
    [{ title: "   ", content: "x" }],
    [{ title: "x".repeat(256), content: "x" }],
    [{ title: "Title", content: "x".repeat(100001) }],
  ])("invalid input is refused before any query", async (input) => {
    const result = await createNote(input);
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("an unauthenticated call is refused before any query", async () => {
    asAnonymous();
    const result = await createNote({ title: "Title", content: "x" });
    expect(result).toEqual({ ok: false, error: "unauthenticated" });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("a database error is unavailable", async () => {
    mockFrom.mockReturnValue(
      fakeQuery({ data: null, error: { message: "boom" } }, []),
    );
    const result = await createNote({ title: "Title", content: "x" });
    expect(result).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("editNote (M2-8b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asUser();
  });

  it("edits the caller's row", async () => {
    const calls: string[] = [];
    mockFrom.mockReturnValue(fakeQuery({ data: ROW, error: null }, calls));
    const result = await editNote(ID, { title: ROW.title, content: ROW.content });
    expect(result).toEqual({ ok: true, data: ROW });
    expect(calls).toContain(
      `update:[{"title":"${ROW.title}","content":"${ROW.content}"}]`,
    );
    expect(calls).toContain(`eq:["id","${ID}"]`);
    expect(calls).toContain(`eq:["user_id","${USER}"]`);
  });

  it("an invalid id or title is refused before any query", async () => {
    expect(await editNote("not-a-uuid", { title: "T", content: "" })).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(await editNote(ID, { title: "", content: "" })).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("a missing or foreign row is not_found", async () => {
    mockFrom.mockReturnValue(
      fakeQuery({ data: null, error: { message: "no rows" } }, []),
    );
    const result = await editNote(OTHER_ID, { title: "T", content: "" });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("an unauthenticated call is refused before any query", async () => {
    asAnonymous();
    const result = await editNote(ID, { title: "T", content: "" });
    expect(result).toEqual({ ok: false, error: "unauthenticated" });
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe("deleteNote (M2-8b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asUser();
  });

  it("deletes the caller's row", async () => {
    const calls: string[] = [];
    mockFrom.mockReturnValue(
      fakeQuery({ data: [{ id: ID }], error: null }, calls),
    );
    const result = await deleteNote(ID);
    expect(result).toEqual({ ok: true, data: { id: ID } });
    expect(calls).toContain("delete");
    expect(calls).toContain(`eq:["id","${ID}"]`);
    expect(calls).toContain(`eq:["user_id","${USER}"]`);
  });

  it("a missing or foreign row is not_found", async () => {
    mockFrom.mockReturnValue(fakeQuery({ data: [], error: null }, []));
    const result = await deleteNote(OTHER_ID);
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("another database error is unavailable", async () => {
    mockFrom.mockReturnValue(
      fakeQuery({ data: null, error: { message: "boom" } }, []),
    );
    const result = await deleteNote(ID);
    expect(result).toEqual({ ok: false, error: "unavailable" });
  });

  it("an invalid id is refused before any query", async () => {
    const result = await deleteNote("not-a-uuid");
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("an unauthenticated call is refused before any query", async () => {
    asAnonymous();
    const result = await deleteNote(ID);
    expect(result).toEqual({ ok: false, error: "unauthenticated" });
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
