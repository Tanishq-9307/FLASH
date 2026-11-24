// @vitest-environment jsdom
// Memory screen tests (M3-23, DESIGN.md §5.1, PRD.md §5.3): the privacy
// warning, CRUD through the mocked Server Actions, the settings toggle
// (flipping it off is the switch the M3-16 injection test reads —
// toggling off stops injection), and the empty and error states.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryScreen } from "@/components/memory-screen";
import { MEMORY_PRIVACY_WARNING } from "@/lib/memories";

const mockUpdateMemory = vi.fn();
const mockDeleteMemory = vi.fn();
const mockSetMemoryEnabled = vi.fn();

vi.mock("@/app/memory/actions", () => ({
  updateMemory: (...args: unknown[]) => mockUpdateMemory(...args),
  deleteMemory: (...args: unknown[]) => mockDeleteMemory(...args),
  setMemoryEnabled: (...args: unknown[]) => mockSetMemoryEnabled(...args),
}));

const ROW = {
  id: "00000000-0000-4000-8000-000000000042",
  fact: "Prefers strong coffee.",
  created_at: "2026-11-24T06:30:00.000Z",
  updated_at: "2026-11-24T06:30:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateMemory.mockResolvedValue({ ok: true, data: { ...ROW, fact: "Prefers tea." } });
  mockDeleteMemory.mockResolvedValue({ ok: true, data: { id: ROW.id } });
  mockSetMemoryEnabled.mockResolvedValue({ ok: true, data: false });
});

afterEach(() => cleanup());

describe("memory screen", () => {
  it("shows the privacy warning from the M3-0 decision", () => {
    render(<MemoryScreen initialMemories={[ROW]} memoryEnabled />);
    expect(screen.getByText("Privacy warning")).toBeInTheDocument();
    expect(screen.getByText(MEMORY_PRIVACY_WARNING)).toBeInTheDocument();
    expect(screen.getByText("Prefers strong coffee.")).toBeInTheDocument();
  });

  it("edits a memory and shows the saved fact", async () => {
    render(<MemoryScreen initialMemories={[ROW]} memoryEnabled />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByLabelText("Edit memory");
    fireEvent.change(box, { target: { value: "Prefers tea." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Prefers tea.")).toBeInTheDocument());
    expect(mockUpdateMemory).toHaveBeenCalledWith(ROW.id, "Prefers tea.");
  });

  it("an empty edit disables Save, so nothing is sent", () => {
    render(<MemoryScreen initialMemories={[ROW]} memoryEnabled />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit memory"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(mockUpdateMemory).not.toHaveBeenCalled();
    // The server still validates (tests/memory-actions.test.ts: an
    // empty fact is refused even if a client bypasses the button).
  });

  it("deletes a memory only after confirmation", async () => {
    render(<MemoryScreen initialMemories={[ROW]} memoryEnabled />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Prefers strong coffee.")).toBeInTheDocument();
    expect(mockDeleteMemory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() =>
      expect(screen.queryByText("Prefers strong coffee.")).toBeNull(),
    );
    expect(mockDeleteMemory).toHaveBeenCalledWith(ROW.id);
  });

  it("toggling off calls setMemoryEnabled(false) — the switch that stops injection", async () => {
    render(<MemoryScreen initialMemories={[ROW]} memoryEnabled />);
    const toggle = screen.getByRole("switch", { name: "Memory" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mockSetMemoryEnabled).toHaveBeenCalledWith(false),
    );
    expect(toggle).toHaveAttribute("aria-checked", "false");
    // The M3-16 injection test proves the other half: with the switch
    // off, loadMemoryBlock returns null and nothing is injected.
  });

  it("a failed toggle save reverts the switch and says so", async () => {
    mockSetMemoryEnabled.mockResolvedValue({ ok: false, error: "unavailable" });
    render(<MemoryScreen initialMemories={[ROW]} memoryEnabled />);
    const toggle = screen.getByRole("switch", { name: "Memory" });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Could not save the setting"),
    );
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("empty list shows the empty state", () => {
    render(<MemoryScreen initialMemories={[]} memoryEnabled />);
    expect(screen.getByText(/No memories yet/)).toBeInTheDocument();
  });

  it("a failed load shows Unavailable, never an empty list", () => {
    render(<MemoryScreen initialMemories={null} memoryEnabled={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Unavailable");
    expect(screen.getByText("Memory setting: Unavailable.")).toBeInTheDocument();
    expect(screen.queryByText(/No memories yet/)).toBeNull();
  });
});
