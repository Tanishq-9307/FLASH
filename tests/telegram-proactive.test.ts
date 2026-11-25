// Proactive evaluation tests (Phase 3): nudges come only from real
// state — overdue tasks, tasks due today, high usage — bounded,
// deduped by stable keys, and never during quiet hours.
import { describe, expect, it } from "vitest";
import {
  evaluateProactiveNudges,
  filterUnsentNudges,
  isQuietHours,
  MAX_PROACTIVE_NUDGES_PER_RUN,
  PROACTIVE_USAGE_THRESHOLD_PERCENT,
} from "@/lib/telegram/proactive";
import type { Task } from "@/lib/tasks";

function task(overrides: Partial<Task> & { id: string; title: string }): Task {
  return {
    id: overrides.id,
    title: overrides.title,
    due_date: overrides.due_date ?? null,
    status: overrides.status ?? "pending",
    created_at: "2026-11-20T00:00:00.000Z",
    updated_at: "2026-11-20T00:00:00.000Z",
  };
}

const TODAY = "2026-11-25";

describe("evaluateProactiveNudges", () => {
  it("sends nothing when nothing is due and usage is low", () => {
    expect(
      evaluateProactiveNudges({
        tasks: [task({ id: "t1", title: "Later" })],
        modelUsage: 10,
        modelCap: 1000,
        today: TODAY,
      }),
    ).toEqual([]);
  });

  it("nudges once per overdue task, oldest due first", () => {
    const nudges = evaluateProactiveNudges({
      tasks: [
        task({ id: "t1", title: "Pay caution money", due_date: "2026-11-20T00:00:00+05:30" }),
        task({ id: "t2", title: "Oldest", due_date: "2026-11-18T00:00:00+05:30" }),
        task({ id: "t3", title: "Done overdue", due_date: "2026-11-19T00:00:00+05:30", status: "completed" }),
      ],
      modelUsage: 0,
      modelCap: 1000,
      today: TODAY,
    });
    expect(nudges).toHaveLength(2);
    expect(nudges[0].kind).toBe("overdue_task");
    expect(nudges[0].text).toContain("Oldest");
    expect(nudges[0].text).toContain("2026-11-18");
    expect(nudges[1].text).toContain("Pay caution money");
    expect(nudges[0].key).toBe("overdue:t2:2026-11-18");
    expect(nudges.map((n) => n.text).join(" ")).not.toContain("Done overdue");
  });

  it("combines due-today tasks into one nudge", () => {
    const nudges = evaluateProactiveNudges({
      tasks: [
        task({ id: "t1", title: "IASc deadline", due_date: "2026-11-25T00:00:00+05:30" }),
        task({ id: "t2", title: "Gym", due_date: "2026-11-25T00:00:00+05:30" }),
      ],
      modelUsage: 0,
      modelCap: 1000,
      today: TODAY,
    });
    expect(nudges).toHaveLength(1);
    expect(nudges[0].kind).toBe("due_today");
    expect(nudges[0].text).toContain("IASc deadline");
    expect(nudges[0].text).toContain("Gym");
    expect(nudges[0].text).toContain("Due today (2)");
  });

  it("nudges on high usage at the threshold, never below it", () => {
    const high = evaluateProactiveNudges({
      tasks: [],
      modelUsage: 800,
      modelCap: 1000,
      today: TODAY,
    });
    expect(high).toHaveLength(1);
    expect(high[0].kind).toBe("high_usage");
    expect(high[0].text).toContain("800/1000");
    expect(high[0].text).toContain("80%");
    expect(
      evaluateProactiveNudges({
        tasks: [],
        modelUsage: 799,
        modelCap: 1000,
        today: TODAY,
      }),
    ).toEqual([]);
    expect(PROACTIVE_USAGE_THRESHOLD_PERCENT).toBe(80);
  });

  it("bounds a run to at most MAX_PROACTIVE_NUDGES_PER_RUN, overdue first", () => {
    const tasks = Array.from({ length: 5 }, (_, i) =>
      task({
        id: `t${i}`,
        title: `Overdue ${i}`,
        due_date: `2026-11-1${i}T00:00:00+05:30`,
      }),
    );
    const nudges = evaluateProactiveNudges({
      tasks,
      modelUsage: 900,
      modelCap: 1000,
      today: TODAY,
    });
    expect(nudges).toHaveLength(MAX_PROACTIVE_NUDGES_PER_RUN);
    expect(nudges.every((n) => n.kind === "overdue_task")).toBe(true);
    expect(MAX_PROACTIVE_NUDGES_PER_RUN).toBe(3);
  });
});

describe("filterUnsentNudges", () => {
  it("drops keys already sent and keeps the rest", () => {
    const nudges = evaluateProactiveNudges({
      tasks: [
        task({ id: "t1", title: "A", due_date: "2026-11-20T00:00:00+05:30" }),
        task({ id: "t2", title: "B", due_date: "2026-11-21T00:00:00+05:30" }),
      ],
      modelUsage: 0,
      modelCap: 1000,
      today: TODAY,
    });
    const kept = filterUnsentNudges(nudges, new Set(["overdue:t1:2026-11-20"]));
    expect(kept).toHaveLength(1);
    expect(kept[0].key).toBe("overdue:t2:2026-11-21");
  });
});

describe("isQuietHours", () => {
  it("is quiet 23:00–07:00 IST and loud in between", () => {
    // 17:30 UTC = 23:00 IST; 01:30 UTC = 07:00 IST.
    expect(isQuietHours(new Date("2026-11-25T17:30:00Z"))).toBe(true);
    expect(isQuietHours(new Date("2026-11-25T01:00:00Z"))).toBe(true);
    expect(isQuietHours(new Date("2026-11-25T01:30:00Z"))).toBe(false);
    expect(isQuietHours(new Date("2026-11-25T03:30:00Z"))).toBe(false);
  });
});
