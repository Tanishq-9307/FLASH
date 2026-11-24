// M2-8a: pure task rules in lib/tasks.ts — no mocks, no database.
import { describe, expect, it } from "vitest";
import {
  dueDayToTimestamp,
  sortTasks,
  timestampToDueDay,
  type Task,
} from "@/lib/tasks";

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: "Task",
    due_date: null,
    status: "pending",
    created_at: "2026-11-24T09:00:00Z",
    updated_at: "2026-11-24T09:00:00Z",
    ...overrides,
  };
}

describe("task rules (M2-8a)", () => {
  it("a due day is midnight at the start of that day in India", () => {
    expect(dueDayToTimestamp("2026-11-25")).toBe("2026-11-25T00:00:00+05:30");
    expect(dueDayToTimestamp("")).toBeNull();
  });

  it("a stored timestamp maps back to its Kolkata calendar day", () => {
    expect(timestampToDueDay("2026-11-25T00:00:00+05:30")).toBe("2026-11-25");
    // 2026-11-24 20:00 UTC is 2026-11-25 01:30 in Kolkata.
    expect(timestampToDueDay("2026-11-24T20:00:00Z")).toBe("2026-11-25");
    expect(timestampToDueDay(null)).toBe("");
  });

  it("sorts pending first, then by due day, no-date last, then newest", () => {
    const done = task({ id: "done", status: "completed", due_date: "2026-11-20T00:00:00+05:30" });
    const late = task({ id: "late", due_date: "2026-11-26T00:00:00+05:30" });
    const early = task({ id: "early", due_date: "2026-11-24T00:00:00+05:30" });
    const nodate = task({ id: "nodate", due_date: null });
    const newer = task({ id: "newer", due_date: null, created_at: "2026-11-24T10:00:00Z" });
    expect(sortTasks([done, late, nodate, early, newer]).map((t) => t.id)).toEqual([
      "early",
      "late",
      "newer",
      "nodate",
      "done",
    ]);
  });
});
