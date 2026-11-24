// @vitest-environment jsdom
// Overview real-data wiring tests (M2-9b): every figure on the Overview is
// real — a failed load shows "Unavailable", never zero. The UsagePanel reads
// /api/health in the browser; Tasks and Notes arrive as props from the
// server actions, and a failed server load passes null (covered in
// tests/overview.test.tsx).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsagePanel } from "@/components/overview/usage-panel";

function mockHealth(response: unknown, ok = true) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    json: async () => response,
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  mockHealth({ status: "online", usage: 7, cap: 20 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("UsagePanel real-data wiring", () => {
  it("shows today's real model calls from /api/health", async () => {
    render(<UsagePanel tasks={{ done: 3, total: 9 }} />);
    expect(await screen.findByText("7 of 20")).toBeTruthy();
    expect(screen.getByText("3 of 9")).toBeTruthy();
    // 7 of 20 = 35% used — the meter, not a WITHIN LIMITS label.
    expect(screen.getByText("35% used")).toBeTruthy();
  });

  it("failed fetch shows Unavailable, never zero", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    render(<UsagePanel tasks={{ done: 3, total: 9 }} />);
    expect(await screen.findByText("Unavailable")).toBeTruthy();
    expect(screen.queryByText("0 of 20")).toBeNull();
  });

  it("non-200 response shows Unavailable, never zero", async () => {
    mockHealth({ error: "unauthenticated" }, false);
    render(<UsagePanel tasks={null} />);
    expect(await screen.findByText("Unavailable")).toBeTruthy();
    expect(screen.queryByText("0 of 20")).toBeNull();
  });

  it("malformed health body shows Unavailable, never zero", async () => {
    mockHealth({ usage: "7", cap: 20 });
    render(<UsagePanel tasks={null} />);
    expect(await screen.findByText("Unavailable")).toBeTruthy();
  });

  it("full usage reads 100% used, never LIMIT REACHED", async () => {
    mockHealth({ status: "online", usage: 20, cap: 20 });
    render(<UsagePanel tasks={null} />);
    expect(await screen.findByText(/100% used/)).toBeTruthy();
    expect(screen.queryByText("LIMIT REACHED")).toBeNull();
  });

  it("shows the monthly search meter from /api/health", async () => {
    mockHealth({ status: "online", usage: 7, cap: 20, searchUsage: 250, searchCap: 1000 });
    render(<UsagePanel tasks={null} />);
    expect(await screen.findByText(/Search this month/)).toBeTruthy();
    expect(screen.getByText(/25% used/)).toBeTruthy();
    expect(screen.getByText(/250 of 1000 credits/)).toBeTruthy();
  });

  it("no task tally means the Tasks-done gauge says Unavailable, not zero", async () => {
    render(<UsagePanel tasks={null} />);
    expect(await screen.findByText("7 of 20")).toBeTruthy();
    // The Tasks-done gauge's own Unavailable label, distinct from the panel's.
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("0 of 0")).toBeNull();
  });
});
