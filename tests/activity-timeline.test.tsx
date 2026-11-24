// @vitest-environment jsdom
// Activity timeline tests (M3-22, DESIGN.md §5.6/§9): rendering per
// status, tamper highlight, error state, empty state, filters, and
// expandable parameters shown as plain text.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityTimeline } from "@/components/activity-timeline";
import type { ActivityLogRow } from "@/lib/activity";

afterEach(() => cleanup());

function row(overrides: Partial<ActivityLogRow> = {}): ActivityLogRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    tool_name: "create_task",
    parameters: { title: "Buy milk" },
    execution_status: "succeeded",
    result_payload: { task_id: "t1" },
    created_at: "2026-11-24T06:30:00.000Z",
    approval_id: "00000000-0000-4000-8000-000000000042",
    conversation_id: null,
    ...overrides,
  };
}

const ALL_STATUSES: Array<{ status: string; label: string; icon: string }> = [
  { status: "succeeded", label: "Succeeded", icon: "✓" },
  { status: "failed", label: "Failed", icon: "✕" },
  { status: "not_executed", label: "Not executed", icon: "⊘" },
  { status: "unknown", label: "Unknown", icon: "?" },
  { status: "pending", label: "Pending", icon: "◌" },
];

describe("activity timeline statuses", () => {
  it.each(ALL_STATUSES)("renders $status with its icon and text label", ({ status, label, icon }) => {
    render(<ActivityTimeline rows={[row({ execution_status: status })]} />);
    const article = screen.getByRole("article");
    expect(within(article).getByText(label)).toBeInTheDocument();
    expect(within(article).getByText(icon)).toBeInTheDocument();
    expect(within(article).getByText("create_task")).toBeInTheDocument();
  });

  it("failed rows show the reason from the payload", () => {
    render(
      <ActivityTimeline
        rows={[row({ execution_status: "failed", result_payload: { error: "tool_error" } })]}
      />,
    );
    expect(screen.getByText("tool_error")).toBeInTheDocument();
  });

  it("shows the timestamp from the row", () => {
    render(<ActivityTimeline rows={[row()]} />);
    const time = screen.getByText("24 Nov 2026, 12:00 pm");
    expect(time.tagName).toBe("TIME");
    expect(time.getAttribute("dateTime")).toBe("2026-11-24T06:30:00.000Z");
  });
});

describe("activity timeline tamper", () => {
  it("tamper rows are highlighted with a danger border and the Possible tamper text", () => {
    render(
      <ActivityTimeline
        rows={[
          row({
            id: "00000000-0000-4000-8000-000000000002",
            execution_status: "not_executed",
            result_payload: { reason: "hash_mismatch", tamper: true },
          }),
        ]}
      />,
    );
    expect(screen.getByText("Possible tamper")).toBeInTheDocument();
    expect(screen.getByText("hash_mismatch")).toBeInTheDocument();
    const article = screen.getByText("Possible tamper").closest("article");
    expect(article?.className).toContain("border-danger");
  });

  it("rows without the tamper flag are not highlighted", () => {
    render(<ActivityTimeline rows={[row()]} />);
    expect(screen.queryByText("Possible tamper")).toBeNull();
  });
});

describe("activity timeline parameters", () => {
  it("parameters expand as plain text and HTML is shown literally", () => {
    const hostile = '<img src="x" onerror="alert(1)">';
    render(
      <ActivityTimeline
        rows={[row({ parameters: { title: hostile } })]}
      />,
    );
    expect(document.querySelector("pre")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show parameters" }));
    const pre = document.querySelector("pre");
    // The value is JSON text, so quotes are backslash-escaped — but the
    // markup is still plain text: no <img> element is ever created.
    expect(pre?.textContent).toContain('<img src=\\"x\\" onerror=\\"alert(1)\\">');
    expect(document.querySelector("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide parameters" }));
    expect(document.querySelector("pre")).toBeNull();
  });
});

describe("activity timeline states and filters", () => {
  it("empty list shows the empty state", () => {
    render(<ActivityTimeline rows={[]} />);
    expect(screen.getByText(/No activity yet/)).toBeInTheDocument();
  });

  it("a failed load shows Unavailable, never an empty list", () => {
    render(<ActivityTimeline rows={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Unavailable");
    expect(screen.queryByText(/No activity yet/)).toBeNull();
  });

  it("status filter narrows the rows", () => {
    render(
      <ActivityTimeline
        rows={[
          row({ id: "00000000-0000-4000-8000-000000000001" }),
          row({
            id: "00000000-0000-4000-8000-000000000002",
            tool_name: "get_tasks",
            execution_status: "failed",
            result_payload: null,
          }),
        ]}
      />,
    );
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "failed" } });
    const articles = screen.getAllByRole("article");
    expect(articles).toHaveLength(1);
    expect(within(articles[0]).getByText("Failed")).toBeInTheDocument();
    expect(within(articles[0]).getByText("get_tasks")).toBeInTheDocument();
  });

  it("tool filter and tamper-only filter combine", () => {
    render(
      <ActivityTimeline
        rows={[
          row({ id: "00000000-0000-4000-8000-000000000001" }),
          row({
            id: "00000000-0000-4000-8000-000000000002",
            execution_status: "not_executed",
            result_payload: { reason: "hash_mismatch", tamper: true },
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByLabelText("Tamper flags only"));
    expect(screen.queryAllByRole("article")).toHaveLength(1);
    expect(screen.getByText("Possible tamper")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Tool"), { target: { value: "get_tasks" } });
    expect(screen.getByText(/No activity matches/)).toBeInTheDocument();
  });
});
