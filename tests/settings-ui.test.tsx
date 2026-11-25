// @vitest-environment jsdom
// Settings panel tests (Phase 2, 2026-11-25).
//
// Covers the live panel: all five settings render as switches, a
// flip saves through updateSettings, reduce motion applies to the
// live document the moment it flips (no reload), a failed save
// reverts the switch and says so, an unloaded panel says
// "Unavailable" instead of guessing, and the rendered panel never
// mentions a credential — no key, token, secret, or password field
// exists anywhere in it.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "@/components/settings-panel";
import { DEFAULT_SETTINGS, type AppSettings } from "@/lib/settings";

const mockUpdate = vi.fn();

vi.mock("@/app/settings/actions", () => ({
  updateSettings: (...args: unknown[]) => mockUpdate(...args),
}));

afterEach(() => {
  cleanup();
  document.documentElement.dataset.reduceMotion = "false";
});

function renderPanel(initial: AppSettings | null = DEFAULT_SETTINGS) {
  render(<SettingsPanel initial={initial} />);
}

describe("settings panel (Phase 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue({ ok: true, data: DEFAULT_SETTINGS });
  });

  it("renders all five settings as switches with their saved state", () => {
    renderPanel({
      ...DEFAULT_SETTINGS,
      default_coding_mode: true,
      show_usage_meter: false,
    });
    expect(screen.getByRole("switch", { name: "Memory" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getByRole("switch", { name: "Default model: coding" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("switch", { name: "Proactive nudges" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Reduce motion" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("switch", { name: "Usage meter" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("never mentions a credential anywhere in the panel", () => {
    renderPanel();
    expect(document.body.textContent).not.toMatch(/api[_ ]?key|token|secret|password/i);
    expect(screen.queryByLabelText(/key|token|secret|password/i)).toBeNull();
  });

  it("flipping a switch saves immediately and keeps the new state", async () => {
    mockUpdate.mockResolvedValue({
      ok: true,
      data: { ...DEFAULT_SETTINGS, show_usage_meter: false },
    });
    renderPanel();
    fireEvent.click(screen.getByRole("switch", { name: "Usage meter" }));
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith({ show_usage_meter: false }),
    );
    expect(screen.getByRole("switch", { name: "Usage meter" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("flipping reduce motion applies it to the live document at once", async () => {
    document.documentElement.dataset.reduceMotion = "false";
    mockUpdate.mockResolvedValue({
      ok: true,
      data: { ...DEFAULT_SETTINGS, reduce_motion: true },
    });
    renderPanel();
    fireEvent.click(screen.getByRole("switch", { name: "Reduce motion" }));
    // Immediate: the attribute changes in the same tick as the click,
    // before the mocked save resolves.
    expect(document.documentElement.dataset.reduceMotion).toBe("true");
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith({ reduce_motion: true }),
    );
  });

  it("a failed save reverts the switch and the document, and says so", async () => {
    document.documentElement.dataset.reduceMotion = "false";
    mockUpdate.mockResolvedValue({ ok: false, error: "unavailable" });
    renderPanel();
    fireEvent.click(screen.getByRole("switch", { name: "Reduce motion" }));
    expect(document.documentElement.dataset.reduceMotion).toBe("true");
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not save the setting. Nothing was changed.",
      ),
    );
    expect(screen.getByRole("switch", { name: "Reduce motion" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(document.documentElement.dataset.reduceMotion).toBe("false");
  });

  it("an unloaded panel says Unavailable and renders no switches", () => {
    renderPanel(null);
    expect(screen.getByText(/Settings: Unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
