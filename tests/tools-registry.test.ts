// Tool registry tests (M3-15): valid and invalid arguments per tool,
// unknown tool rejected, model-supplied risk ignored, and no tool
// exposed to the model with an automatic execute function.
import { describe, expect, it } from "vitest";
import {
  TOOL_NAMES,
  TOOLS,
  getTool,
  isKnownTool,
  toModelTools,
  validateToolCall,
} from "@/lib/tools/registry";

describe("tool registry (M3-15)", () => {
  it("registers exactly get_tasks, create_task and save_memory with the right kinds and static risks", () => {
    expect(TOOL_NAMES).toEqual(["get_tasks", "create_task", "save_memory"]);
    expect(TOOLS.map((t) => [t.name, t.kind, t.risk])).toEqual([
      ["get_tasks", "read-only", "low"],
      ["create_task", "state-changing", "medium"],
      ["save_memory", "state-changing", "high"],
    ]);
    // Every definition carries the full PRD §5.5 metadata.
    for (const def of TOOLS) {
      for (const field of [
        "description",
        "displayLabel",
        "resultFormat",
        "errorFormat",
        "executionPath",
        "permission",
      ] as const) {
        expect(def[field].length, `${def.name}.${field}`).toBeGreaterThan(0);
      }
    }
  });

  it("get_tasks accepts no arguments or a valid status filter", () => {
    for (const args of [{}, { status: "pending" }, { status: "completed" }]) {
      const result = validateToolCall("get_tasks", args);
      expect(result.ok, JSON.stringify(args)).toBe(true);
      if (result.ok) expect(result.tool.name).toBe("get_tasks");
    }
  });

  it("get_tasks rejects an unknown status value", () => {
    const result = validateToolCall("get_tasks", { status: "done" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_arguments");
      expect(result.details?.fieldErrors.status).toBeDefined();
    }
    expect(validateToolCall("get_tasks", { status: 3 }).ok).toBe(false);
  });

  it("create_task accepts a title alone, with a due date, and with a null due date", () => {
    const onlyTitle = validateToolCall("create_task", { title: "Buy milk" });
    expect(onlyTitle.ok).toBe(true);
    if (onlyTitle.ok) {
      expect(onlyTitle.args).toEqual({ title: "Buy milk" });
    }
    const withDate = validateToolCall("create_task", {
      title: "Buy milk",
      due_date: "2026-12-01",
    });
    expect(withDate.ok).toBe(true);
    if (withDate.ok) {
      expect(withDate.args).toEqual({
        title: "Buy milk",
        due_date: "2026-12-01",
      });
    }
    const nullDate = validateToolCall("create_task", {
      title: "Buy milk",
      due_date: null,
    });
    expect(nullDate.ok).toBe(true);
    if (nullDate.ok) {
      // A null due date is normalised to absent.
      expect(nullDate.args).toEqual({ title: "Buy milk" });
    }
  });

  it("create_task trims the title", () => {
    const result = validateToolCall("create_task", { title: "  Buy milk  " });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args).toEqual({ title: "Buy milk" });
  });

  it("create_task rejects a missing, empty, over-long or whitespace-only title and an unparseable due date", () => {
    for (const args of [
      {},
      { title: "" },
      { title: "   " },
      { title: "x".repeat(256) },
      { title: "ok", due_date: "not-a-date" },
      { title: "ok", due_date: 123 },
      { title: 42 },
    ]) {
      const result = validateToolCall("create_task", args);
      expect(result.ok, JSON.stringify(args)).toBe(false);
      if (!result.ok) expect(result.error).toBe("invalid_arguments");
    }
    // Exactly 255 characters is allowed (the table CHECK limit).
    expect(
      validateToolCall("create_task", { title: "x".repeat(255) }).ok,
    ).toBe(true);
  });

  it("save_memory accepts a fact and trims it", () => {
    const result = validateToolCall("save_memory", {
      fact: "  Prefers morning runs. ",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).toEqual({ fact: "Prefers morning runs." });
    }
  });

  it("save_memory rejects a missing, empty or over-long fact", () => {
    for (const args of [
      {},
      { fact: "" },
      { fact: "   " },
      { fact: "x".repeat(10001) },
    ]) {
      const result = validateToolCall("save_memory", args);
      expect(result.ok, JSON.stringify(args)).toBe(false);
      if (!result.ok) expect(result.error).toBe("invalid_arguments");
    }
    // Exactly 10000 characters is allowed (the table CHECK limit).
    expect(
      validateToolCall("save_memory", { fact: "x".repeat(10000) }).ok,
    ).toBe(true);
  });

  it("rejects unknown tool names before any schema runs", () => {
    expect(getTool("delete_task")).toBeUndefined();
    expect(getTool("")).toBeUndefined();
    expect(isKnownTool("delete_task")).toBe(false);
    expect(isKnownTool("get_tasks")).toBe(true);
    const result = validateToolCall("delete_task", { title: "x" });
    expect(result).toEqual({ ok: false, error: "unknown_tool" });
  });

  it("ignores a model-supplied risk field: it is stripped and the static risk stands", () => {
    // The model tries to downgrade a state-changing tool to low risk.
    const downgraded = validateToolCall("create_task", {
      title: "Buy milk",
      risk: "low",
    });
    expect(downgraded.ok).toBe(true);
    if (downgraded.ok) {
      expect(downgraded.args).toEqual({ title: "Buy milk" });
      expect("risk" in (downgraded.args as object)).toBe(false);
    }
    expect(getTool("create_task")?.risk).toBe("medium");
    // And the reverse: claiming a read-only tool is high risk changes nothing.
    const upgraded = validateToolCall("get_tasks", { risk: "high" });
    expect(upgraded.ok).toBe(true);
    if (upgraded.ok) expect(upgraded.args).toEqual({});
    expect(getTool("get_tasks")?.risk).toBe("low");
  });

  it("exposes every tool to the model without an automatic execute function", () => {
    const modelTools = toModelTools();
    expect(Object.keys(modelTools).sort()).toEqual([
      "create_task",
      "get_tasks",
      "save_memory",
    ]);
    for (const name of TOOL_NAMES) {
      const modelTool = modelTools[name];
      // No execute: the server loop drives execution (M3-17/18), so a
      // state-changing tool can never run itself.
      expect("execute" in modelTool, name).toBe(false);
      expect(modelTool.description).toBe(getTool(name)?.description);
    }
  });
});
