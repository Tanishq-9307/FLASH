// M2-8a: task Server Actions.
// - Every action calls getUser() first; unauthenticated is refused
//   before any query.
// - Every query filters by the caller's user_id (insert writes it),
//   so a foreign id can never match even if RLS were misconfigured.
// - Titles and dates are validated against the same limits as the DB
//   CHECKs (title 1–255, status pending/completed, due day YYYY-MM-DD).
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
  createTask,
  deleteTask,
  editTask,
  listTasks,
  setTaskStatus,
} from "@/app/tasks/actions";

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
  title: "Buy milk",
  due_date: "2026-11-25T00:00:00+05:30",
  status: "pending",
  created_at: "2026-11-24T09:00:00Z",
  updated_at: "2026-11-24T09:00:00Z",
};

describe("listTasks (M2-8a)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asUser();
  });

  it("returns the caller's rows sorted pending first", async () => {
    const calls: string[] = [];
    const done = { ...ROW, id: OTHER_ID, status: "completed" };
    mockFrom.mockReturnValue(fakeQuery({ data: [done, ROW], error: null }, calls));
    const result = await listTasks();
    expect(result).toEqual({ ok: true, data: [ROW, done] });
    expect(mockFrom).toHaveBeenCalledWith("tasks");
    expect(calls).toContain(`eq:["user_id","${USER}"]`);
  });

  it("an unauthenticated call is refused before any query", async () => {
    asAnonymous();
    const result = await listTasks();
    expect(result).toEqual({ ok: false, error: "unauthenticated" });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("a database error is unavailable", async () => {
    mockFrom.mockReturnValue(
      fakeQuery({ data: null, error: { message: "boom" } }, []),
    );
    const result = await listTasks();
    expect(result).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("createTask (M2-8a)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asUser();
  });

  it("creates the row with a trimmed title and a Kolkata-midnight due date", async () => {
    const calls: string[] = [];
    mockFrom.mockReturnValue(fakeQuery({ data: ROW, error: null }, calls));
    const result = await createTask({ title: "  Buy  milk ", dueDay: "2026-11-25" });
    expect(result).toEqual({ ok: true, data: ROW });
    expect(calls).toContain(
      `insert:[{"title":"Buy milk","due_date":"2026-11-25T00:00:00+05:30","user_id":"${USER}"}]`,
    );
  });

  it("an empty due day writes a null due date", async () => {
    const calls: string[] = [];
    mockFrom.mockReturnValue(fakeQuery({ data: ROW, error: null }, calls));
    const result = await createTask({ title: "Buy milk", dueDay: "" });
    expect(result.ok).toBe(true);
    expect(calls).toContain(
      `insert:[{"title":"Buy milk","due_date":null,"user_id":"${USER}"}]`,
    );
  });

  it.each([
    [{ title: "", dueDay: "" }],
    [{ title: "   ", dueDay: "" }],
    [{ title: "x".repeat(256), dueDay: "" }],
    [{ title: "Buy milk", dueDay: "25 Nov 2026" }],
    [{ title: "Buy milk", dueDay: "2026-13-01" }],
  ])("invalid input %p is refused before any query", async (input) => {
    const result = await createTask(input);
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("an unauthenticated call is refused before any query", async () => {
    asAnonymous();
    const result = await createTask({ title: "Buy milk", dueDay: "" });
    expect(result).toEqual({ ok: false, error: "unauthenticated" });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("a database error is unavailable", async () => {
    mockFrom.mockReturnValue(
      fakeQuery({ data: null, error: { message: "boom" } }, []),
    );
    const result = await createTask({ title: "Buy milk", dueDay: "" });
    expect(result).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("editTask (M2-8a)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asUser();
  });

  it("edits the caller's row", async () => {
    const calls: string[] = [];
    mockFrom.mockReturnValue(fakeQuery({ data: ROW, error: null }, calls));
    const result = await editTask(ID, { title: "Buy milk", dueDay: "2026-11-25" });
    expect(result).toEqual({ ok: true, data: ROW });
    expect(calls).toContain(
      `update:[{"title":"Buy milk","due_date":"2026-11-25T00:00:00+05:30"}]`,
    );
    expect(calls).toContain(`eq:["id","${ID}"]`);
    expect(calls).toContain(`eq:["user_id","${USER}"]`);
  });

  it("an invalid id or title is refused before any query", async () => {
    expect(await editTask("not-a-uuid", { title: "Buy milk", dueDay: "" })).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(await editTask(ID, { title: "", dueDay: "" })).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("a missing or foreign row is not_found", async () => {
    mockFrom.mockReturnValue(
      fakeQuery({ data: null, error: { message: "no rows" } }, []),
    );
    const result = await editTask(OTHER_ID, { title: "Buy milk", dueDay: "" });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("an unauthenticated call is refused before any query", async () => {
    asAnonymous();
    const result = await editTask(ID, { title: "Buy milk", dueDay: "" });
    expect(result).toEqual({ ok: false, error: "unauthenticated" });
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe("setTaskStatus (M2-8a)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asUser();
  });

  it("marks the caller's row completed", async () => {
    const calls: string[] = [];
    mockFrom.mockReturnValue(
      fakeQuery({ data: { ...ROW, status: "completed" }, error: null }, calls),
    );
    const result = await setTaskStatus(ID, "completed");
    expect(result.ok).toBe(true);
    expect(calls).toContain(`update:[{"status":"completed"}]`);
    expect(calls).toContain(`eq:["id","${ID}"]`);
    expect(calls).toContain(`eq:["user_id","${USER}"]`);
  });

  it("an invalid status is refused before any query", async () => {
    // @ts-expect-error deliberate invalid status for the test
    const result = await setTaskStatus(ID, "done");
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("a missing or foreign row is not_found", async () => {
    mockFrom.mockReturnValue(
      fakeQuery({ data: null, error: { message: "no rows" } }, []),
    );
    const result = await setTaskStatus(OTHER_ID, "completed");
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("an unauthenticated call is refused before any query", async () => {
    asAnonymous();
    const result = await setTaskStatus(ID, "completed");
    expect(result).toEqual({ ok: false, error: "unauthenticated" });
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe("deleteTask (M2-8a)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asUser();
  });

  it("deletes the caller's row", async () => {
    const calls: string[] = [];
    mockFrom.mockReturnValue(
      fakeQuery({ data: [{ id: ID }], error: null }, calls),
    );
    const result = await deleteTask(ID);
    expect(result).toEqual({ ok: true, data: { id: ID } });
    expect(calls).toContain("delete");
    expect(calls).toContain(`eq:["id","${ID}"]`);
    expect(calls).toContain(`eq:["user_id","${USER}"]`);
  });

  it("a missing or foreign row is not_found", async () => {
    mockFrom.mockReturnValue(fakeQuery({ data: [], error: null }, []));
    const result = await deleteTask(OTHER_ID);
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("another database error is unavailable", async () => {
    mockFrom.mockReturnValue(
      fakeQuery({ data: null, error: { message: "boom" } }, []),
    );
    const result = await deleteTask(ID);
    expect(result).toEqual({ ok: false, error: "unavailable" });
  });

  it("an invalid id is refused before any query", async () => {
    const result = await deleteTask("not-a-uuid");
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("an unauthenticated call is refused before any query", async () => {
    asAnonymous();
    const result = await deleteTask(ID);
    expect(result).toEqual({ ok: false, error: "unauthenticated" });
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
