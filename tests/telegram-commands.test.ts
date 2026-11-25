// Telegram command tests (Phase 3): parsing and reply formatting.
// Pure functions — no network, no database.
import { describe, expect, it } from "vitest";
import {
  formatTaskList,
  formatUsage,
  isTelegramCommand,
  parseTelegramCommand,
  TELEGRAM_HELP_TEXT,
} from "@/lib/telegram/commands";
import type { Task } from "@/lib/tasks";

function task(overrides: Partial<Task> & { title: string }): Task {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    title: overrides.title,
    due_date: overrides.due_date ?? null,
    status: overrides.status ?? "pending",
    created_at: "2026-11-25T00:00:00.000Z",
    updated_at: "2026-11-25T00:00:00.000Z",
  };
}

describe("parseTelegramCommand", () => {
  it("returns null for plain text", () => {
    expect(parseTelegramCommand("hello there")).toBeNull();
    expect(parseTelegramCommand("")).toBeNull();
  });

  it("parses a bare command", () => {
    expect(parseTelegramCommand("/tasks")).toEqual({
      command: "/tasks",
      args: "",
    });
  });

  it("parses a command with arguments", () => {
    expect(parseTelegramCommand("/help  extra ")).toEqual({
      command: "/help",
      args: "extra",
    });
  });

  it("strips a @BotName suffix", () => {
    expect(parseTelegramCommand("/tasks@FlashBot")).toEqual({
      command: "/tasks",
      args: "",
    });
  });

  it("keeps unknown commands for the caller to reject", () => {
    expect(parseTelegramCommand("/dance")).toEqual({
      command: "/dance",
      args: "",
    });
    expect(isTelegramCommand("/dance")).toBe(false);
    expect(isTelegramCommand("/tasks")).toBe(true);
  });
});

describe("TELEGRAM_HELP_TEXT", () => {
  it("lists every command", () => {
    for (const command of ["/tasks", "/usage", "/stop", "/resume", "/help"]) {
      expect(TELEGRAM_HELP_TEXT).toContain(command);
    }
  });
});

describe("formatTaskList", () => {
  it("says so plainly when nothing is pending", () => {
    expect(formatTaskList([])).toBe("No pending tasks.");
    expect(
      formatTaskList([task({ title: "Done", status: "completed" })]),
    ).toBe("No pending tasks.");
  });

  it("lists pending tasks with due days, completed ones excluded", () => {
    const text = formatTaskList([
      task({ title: "Pay caution money", due_date: "2026-11-30T00:00:00+05:30" }),
      task({ title: "No due date" }),
      task({ title: "Done", status: "completed" }),
    ]);
    expect(text).toContain("Pay caution money (due 2026-11-30)");
    expect(text).toContain("No due date");
    expect(text).not.toContain("Done");
  });

  it("caps the list at 10 and says how many more there are", () => {
    const tasks = Array.from({ length: 12 }, (_, i) =>
      task({ title: `Task ${i + 1}` }),
    );
    const text = formatTaskList(tasks);
    expect(text).toContain("Task 10");
    expect(text).not.toContain("Task 11");
    expect(text).toContain("…and 2 more.");
  });
});

describe("formatUsage", () => {
  it("shows model and search usage as percentages", () => {
    expect(formatUsage(250, 1000, 40, 1000)).toBe(
      "Model today: 250/1000 calls (25%)\nWeb search this month: 40/1000 searches (4%)",
    );
  });

  it("shows raw counts when a limit is not positive", () => {
    expect(formatUsage(5, 0, 3, 0)).toBe(
      "Model today: 5 calls\nWeb search this month: 3 searches",
    );
  });
});
