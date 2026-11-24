// @vitest-environment jsdom
// Guided tour tests (M2-9a): step flow, Esc/Skip, focus on the caption
// heading, centred fallback when a target is missing, orb morph per step.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { Tour, TOUR_STEPS, clampStep, nextStep, prevStep } from "@/components/overview/tour";

function Harness({ startStep = 0 }: { startStep?: number }) {
  const [open, setOpen] = useState(true);
  const [step, setStep] = useState(startStep);
  return <Tour open={open} step={step} onStepChange={setStep} onClose={() => setOpen(false)} />;
}

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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Tour step helpers", () => {
  it("clamps and steps within the 8 steps", () => {
    expect(TOUR_STEPS).toHaveLength(8);
    expect(clampStep(-1)).toBe(0);
    expect(clampStep(99)).toBe(7);
    expect(nextStep(0)).toBe(1);
    expect(prevStep(0)).toBe(0);
    expect(nextStep(7)).toBe(7);
  });
});

describe("Tour dialog", () => {
  it("shows step 1 of 8, focuses the heading, and advances with Next", () => {
    stubMatchMedia(false);
    render(<Harness />);
    expect(screen.getByText("Step 1 of 8")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Welcome to FLASH" })).toBeTruthy();
    expect(document.activeElement?.textContent).toContain("Welcome to FLASH");
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText("Step 2 of 8")).toBeTruthy();
    expect(screen.getByText("Central intelligence")).toBeTruthy();
  });

  it("Back is disabled on the first step; Finish closes on the last step", () => {
    stubMatchMedia(false);
    render(<Harness startStep={7} />);
    expect(screen.getByText("Step 8 of 8")).toBeTruthy();
    expect(screen.getByText("Finish")).toBeTruthy();
    fireEvent.click(screen.getByText("Finish"));
    expect(screen.queryByText("Step 8 of 8")).toBeNull();
  });

  it("Skip tour closes and Esc closes", () => {
    stubMatchMedia(false);
    render(<Harness />);
    fireEvent.click(screen.getByText("Skip tour"));
    expect(screen.queryByText("Step 1 of 8")).toBeNull();

    cleanup();
    render(<Harness />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Step 1 of 8")).toBeNull();
  });

  it("a missing target falls back to a centred caption, not a crash", () => {
    stubMatchMedia(false);
    // No [data-tour="approvals"] element exists in this DOM (the panel
    // arrives in M3-24b), so the approvals step must centre its caption.
    render(<Harness startStep={4} />);
    expect(screen.getByText("Step 5 of 8")).toBeTruthy();
    expect(screen.getByText("Nothing happens without you")).toBeTruthy();
    const caption = screen.getByText("Nothing happens without you").closest("div[class*='flash-frame']");
    expect(caption).not.toBeNull();
    expect((caption as HTMLElement).style.transform).toContain("translate(-50%, -50%)");
  });

  it("reduced motion renders the calm static version (no pulse or sweep)", () => {
    stubMatchMedia(true);
    const target = document.createElement("div");
    target.setAttribute("data-tour", "tasks");
    document.body.appendChild(target);
    const { container } = render(<Harness startStep={5} />);
    expect(container.innerHTML).not.toContain("flash-tour-ring");
    expect(container.innerHTML).not.toContain("flash-tour-sweep");
    expect(container.innerHTML).not.toContain("flash-tour-caption-in");
    target.remove();
  });
});
