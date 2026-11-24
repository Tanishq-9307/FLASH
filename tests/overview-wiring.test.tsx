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
    expect(screen.getByText("WITHIN LIMITS")).toBeTruthy();
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

  it("limit reached is labelled when usage hits the cap", async () => {
    mockHealth({ status: "limit_reached", usage: 20, cap: 20 });
    render(<UsagePanel tasks={null} />);
    expect(await screen.findByText("LIMIT REACHED")).toBeTruthy();
    expect(screen.getByText("20 of 20 · limit reached")).toBeTruthy();
  });

  it("no task tally means the Tasks-done gauge says Unavailable, not zero", async () => {
    render(<UsagePanel tasks={null} />);
    expect(await screen.findByText("7 of 20")).toBeTruthy();
    // The Tasks-done gauge's own Unavailable label, distinct from the panel's.
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("0 of 0")).toBeNull();
  });
});
