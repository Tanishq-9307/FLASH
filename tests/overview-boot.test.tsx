// @vitest-environment jsdom
// Boot overlay tests (M2-9a): plays once per session, never under reduced
// motion, fades out after ~3s, never shows a percentage or a progress bar.
import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";

// React's act() needs the test environment flag; @testing-library sets it
// for its own helpers, but this file calls act() directly for fake timers.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BootOverlay } from "@/components/overview/boot-overlay";

const BOOT_KEY = "flash-boot-played";

function stubMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? matches : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  stubMatchMedia(false);
  // Run the requestAnimationFrame callback immediately so the effect's
  // decision happens synchronously in the test.
  global.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  }) as typeof requestAnimationFrame;
  global.cancelAnimationFrame = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("BootOverlay", () => {
  it("plays on the first visit and fades out after ~3s", () => {
    render(<BootOverlay />);
    expect(screen.getByText("FLASH")).toBeTruthy();
    expect(screen.getByText(/Sir\./)).toBeTruthy();
    // The hide is a React state update from the timer, so advance inside act.
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText("FLASH")).toBeNull();
  });

  it("never shows a percentage counter or a progress bar", () => {
    const { container } = render(<BootOverlay />);
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.textContent).not.toMatch(/\d+\s*%/);
  });

  it("does not replay within the same session", () => {
    sessionStorage.setItem(BOOT_KEY, "1");
    render(<BootOverlay />);
    expect(screen.queryByText("FLASH")).toBeNull();
  });

  it("is skipped entirely under reduced motion", () => {
    stubMatchMedia(true);
    render(<BootOverlay />);
    expect(screen.queryByText("FLASH")).toBeNull();
    // And it does not mark the session, so a later non-reduced visit plays.
    expect(sessionStorage.getItem(BOOT_KEY)).toBeNull();
  });
});
