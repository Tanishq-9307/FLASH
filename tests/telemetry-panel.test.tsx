// @vitest-environment jsdom
// Telemetry display tests (2026-11-24): the Usage panel shows real
// measured values, honest empty states, and the browser-metric
// present/absent paths — and never a laptop-hardware figure.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UsagePanel, UsagePanelView, type TelemetryState } from "@/components/overview/usage-panel";
import { CHAT_LATENCY_KEY } from "@/lib/telemetry";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const visibleText = (out: string) => out.replace(/<[^>]*>/g, " ").toLowerCase();
const ok = { kind: "ok", usage: 3, cap: 20 } as const;

const telemetry: TelemetryState = {
  chat: { firstTokenMs: 1200, totalMs: 4500, at: "2026-11-24T14:45:00.000Z" },
  health: { ms: 142, at: "2026-11-24T14:45:00.000Z" },
  heap: {
    usedBytes: 48 * 1024 * 1024,
    totalBytes: 96 * 1024 * 1024,
    limitBytes: 2 * 1024 * 1024 * 1024,
  },
};

function mockHealth(response: unknown, ok = true) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    json: async () => response,
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  window.localStorage.clear();
  mockHealth({ status: "online", usage: 7, cap: 20 });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("UsagePanelView telemetry section", () => {
  it("shows real measured values with when they were taken", () => {
    const out = html(<UsagePanelView state={ok} tasks={null} telemetry={telemetry} />);
    expect(out).toContain("Telemetry");
    expect(out).toContain("Last chat reply:");
    expect(out).toContain("first token 1.2 s");
    expect(out).toContain("completed 4.5 s");
    expect(out).toContain("Health check:");
    expect(out).toContain("142 ms");
    expect(out).toContain("JS heap (browser-reported):");
    expect(out).toContain("48.0 MB used of 96.0 MB");
    // The measured values carry their time, not a bare number.
    expect(out).toMatch(/\d{2}:\d{2}/);
  });

  it("empty states: no chat sample, no health timing, no heap line at all", () => {
    const out = html(
      <UsagePanelView
        state={ok}
        tasks={null}
        telemetry={{ chat: null, health: null, heap: null }}
      />,
    );
    expect(out).toContain("No requests yet");
    expect(out).toContain("Health check:");
    expect(out).toContain("Unavailable");
    // No heap API, no heap line — the absent path leaves it out entirely.
    expect(out).not.toContain("JS heap");
  });

  it("a chat sample alone still shows, without a heap line", () => {
    const out = html(
      <UsagePanelView
        state={ok}
        tasks={null}
        telemetry={{ chat: telemetry.chat, health: null, heap: null }}
      />,
    );
    expect(out).toContain("first token 1.2 s");
    expect(out).not.toContain("JS heap");
  });

  it("shows the app-telemetry-only note and no laptop-hardware words", () => {
    const out = visibleText(
      html(<UsagePanelView state={ok} tasks={null} telemetry={telemetry} />),
    );
    expect(out).toContain("app telemetry only");
    for (const absent of ["cpu", "ram", "thermal", "network sync", "autonomous"]) {
      expect(out).not.toContain(absent);
    }
  });

  it("a failed load shows Unavailable and no telemetry section", () => {
    const out = html(<UsagePanelView state={{ kind: "unavailable" }} />);
    expect(out).toContain("Unavailable");
    expect(out).not.toContain("Telemetry");
    expect(out).not.toContain("Last chat reply");
  });
});

describe("UsagePanel telemetry wiring", () => {
  it("times the real health fetch and shows it", async () => {
    render(<UsagePanel tasks={null} />);
    expect(await screen.findByText("7 of 20")).toBeTruthy();
    expect(screen.getByText("Telemetry")).toBeTruthy();
    expect(screen.getByText(/Health check:/)).toBeTruthy();
    // A real measured duration, not a placeholder: "N ms" or "N.N s".
    expect(screen.getByText(/Health check:/).textContent).toMatch(/\d+(\.\d)? (ms|s)/);
    expect(screen.getByText(/No requests yet/)).toBeTruthy();
  });

  it("shows the last measured chat reply kept by Chat", async () => {
    window.localStorage.setItem(
      CHAT_LATENCY_KEY,
      JSON.stringify({ firstTokenMs: 800, totalMs: 3100, at: "2026-11-24T14:45:00.000Z" }),
    );
    render(<UsagePanel tasks={null} />);
    expect(await screen.findByText(/first token 800 ms/)).toBeTruthy();
    expect(screen.getByText(/completed 3.1 s/)).toBeTruthy();
    expect(screen.queryByText(/No requests yet/)).toBeNull();
  });

  it("a failed fetch shows Unavailable, never a telemetry number", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    render(<UsagePanel tasks={null} />);
    expect(await screen.findByText("Unavailable")).toBeTruthy();
    expect(screen.queryByText("Telemetry")).toBeNull();
    expect(screen.queryByText(/Health check:/)).toBeNull();
  });
});
