// Overview M3 wiring tests (M3-24b, DESIGN.md §2/§5.7/§5.8): the
// open-approvals gauge and memory state in Usage & Limits, the
// "Awaiting your approval" card on Tasks, the registry capability
// chips, the Activity panel, and the conditional Review approval
// action — all from real data shapes, with failure states showing
// "Unavailable", never zero. Static markup, like tests/overview.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UsagePanelView } from "@/components/overview/usage-panel";
import { TasksPanel } from "@/components/overview/tasks-panel";
import { QuickActions } from "@/components/overview/quick-actions";
import { CapabilityChips } from "@/components/overview/capability-chips";
import { ActivityPanel } from "@/components/overview/activity-panel";
import { Overview } from "@/components/overview/overview";
import { getCapabilityChips, TOOL_NAMES, type CapabilityChip } from "@/lib/tools/registry";
import type { OpenApproval } from "@/app/approvals/actions";
import type { ActivityLogRow } from "@/lib/activity";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const text = (out: string) => out.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").toLowerCase();

const APPROVAL: OpenApproval = {
  id: "00000000-0000-4000-8000-000000000042",
  toolName: "create_task",
  conversationId: "00000000-0000-4000-8000-000000000001",
  createdAt: "2026-11-24T06:30:00.000Z",
  expiresAt: "2026-11-24T06:35:00.000Z",
};

const ROW: ActivityLogRow = {
  id: "00000000-0000-4000-8000-000000000001",
  tool_name: "get_tasks",
  parameters: null,
  execution_status: "succeeded",
  result_payload: null,
  created_at: "2026-11-24T06:30:00.000Z",
  approval_id: null,
  conversation_id: null,
};

const CHIPS: CapabilityChip[] = [
  { name: "get_tasks", label: "View tasks", kind: "read-only", available: true, state: "available" },
  { name: "web_search", label: "Web search", kind: "read-only", available: false, state: "unavailable — no search API key" },
  { name: "create_task", label: "Create task", kind: "state-changing", available: true, state: "available" },
  { name: "save_memory", label: "Save memory", kind: "state-changing", available: true, state: "available" },
];

describe("UsagePanel open approvals and memory (M3-24b)", () => {
  const ok = { kind: "ok", usage: 7, cap: 20 } as const;

  it("one open approval fills the gauge and memory on is shown", () => {
    const out = text(html(<UsagePanelView state={ok} tasks={{ done: 3, total: 9 }} openApprovals={1} memoryEnabled />));
    expect(out).toContain("open approvals");
    expect(out).toContain("1 of 1");
    expect(out).toContain("memory: on");
  });

  it("no open approval shows an empty gauge and memory off is shown", () => {
    const out = text(html(<UsagePanelView state={ok} tasks={null} openApprovals={0} memoryEnabled={false} />));
    expect(out).toContain("0 of 1");
    expect(out).toContain("memory: off");
  });

  it("a failed approvals load says Unavailable, never zero", () => {
    const out = text(html(<UsagePanelView state={ok} tasks={null} openApprovals={null} memoryEnabled={null} />));
    expect(out).toContain("open approvals");
    expect(out).toContain("unavailable");
    expect(out).toContain("memory: unavailable");
    expect(out).not.toContain("0 of 1");
  });
});

describe("TasksPanel approval card (M3-24b)", () => {
  it("an open approval shows the card with a Review approval link to the chat", () => {
    const out = html(
      <TasksPanel today="2026-11-24" tasks={[]} openApprovals={[APPROVAL]} />,
    );
    expect(text(out)).toContain("awaiting your approval");
    expect(out).toContain("Create task");
    expect(out).toContain(`/chat?id=${APPROVAL.conversationId}`);
    expect(out).toContain("Review approval");
  });

  it("no open approval shows no card", () => {
    const out = text(html(<TasksPanel today="2026-11-24" tasks={[]} openApprovals={[]} />));
    expect(out).not.toContain("awaiting your approval");
    expect(out).not.toContain("review approval");
  });

  it("a failed approvals load shows no card — the Usage gauge reports it", () => {
    const out = text(html(<TasksPanel today="2026-11-24" tasks={[]} openApprovals={null} />));
    expect(out).not.toContain("awaiting your approval");
  });
});

describe("CapabilityChips (M3-24b)", () => {
  it("shows every registered tool, with the unavailable one greyed and its state", () => {
    const out = text(html(<CapabilityChips chips={CHIPS} />));
    for (const chip of CHIPS) expect(out).toContain(chip.label.toLowerCase());
    expect(out).toContain("unavailable — no search api key");
    expect(out).toContain("read-only");
    expect(out).toContain("needs approval");
  });

  it("a failed load shows Unavailable, never an empty chip row", () => {
    const out = text(html(<CapabilityChips chips={null} />));
    expect(out).toContain("unavailable");
    expect(out).not.toContain("view tasks");
  });
});

describe("getCapabilityChips (M3-24b)", () => {
  beforeEach(() => {
    vi.stubEnv("TAVILY_API_KEY", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("comes from the registry: one chip per registered tool, nothing else", () => {
    const chips = getCapabilityChips();
    expect(chips.map((c) => c.name)).toEqual([...TOOL_NAMES]);
  });

  it("web search is unavailable without the key and available with it", () => {
    expect(getCapabilityChips().find((c) => c.name === "web_search")?.available).toBe(false);
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    expect(getCapabilityChips().find((c) => c.name === "web_search")?.available).toBe(true);
  });
});

describe("ActivityPanel (M3-24b)", () => {
  it("shows the latest rows with icon, text status, tool and time", () => {
    const out = text(
      html(
        <ActivityPanel
          rows={[
            ROW,
            { ...ROW, id: "00000000-0000-4000-8000-000000000002", tool_name: "web_search", execution_status: "failed", result_payload: { reason: "provider error" } },
          ]}
        />,
      ),
    );
    expect(out).toContain("get_tasks");
    expect(out).toContain("web_search");
    expect(out).toContain("succeeded");
    expect(out).toContain("failed");
  });

  it("a failed load shows Unavailable, never an empty list", () => {
    const out = text(html(<ActivityPanel rows={null} />));
    expect(out).toContain("unavailable");
    expect(out).not.toContain("no activity yet");
  });

  it("empty shows the empty state", () => {
    expect(text(html(<ActivityPanel rows={[]} />))).toContain("no activity yet");
  });
});

describe("QuickActions Review approval (M3-24b)", () => {
  it("appears only while an approval is open, linking to its chat", () => {
    const open = html(<QuickActions openApproval={{ conversationId: APPROVAL.conversationId }} />);
    expect(open).toContain("Review approval");
    expect(open).toContain(`/chat?id=${APPROVAL.conversationId}`);
    const closed = text(html(<QuickActions openApproval={null} />));
    expect(closed).not.toContain("review approval");
    expect(closed).toContain("new task");
    expect(closed).toContain("new note");
  });
});

describe("Overview M3 wiring (M3-24b)", () => {
  it("renders the approval card, chips, activity and review action together", () => {
    const out = text(
      html(
        <Overview
          usage={null}
          tasks={[]}
          notes={[]}
          today="2026-11-24"
          openApprovals={[APPROVAL]}
          activity={[ROW]}
          chips={CHIPS}
        />,
      ),
    );
    expect(out).toContain("awaiting your approval");
    expect(out).toContain("capabilities");
    expect(out).toContain("web search");
    expect(out).toContain("activity");
    expect(out).toContain("get_tasks");
    expect(out).toContain("review approval");
  });
});
