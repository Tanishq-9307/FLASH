// @vitest-environment jsdom
// Note board tests (M2-8b): create, edit, delete, search (matching and
// non-matching terms), empty and error states. The Server Actions are
// mocked.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteBoard } from "@/components/note-board";
import type { Note } from "@/lib/notes";

const mockSearch = vi.fn();
const mockCreate = vi.fn();
const mockEdit = vi.fn();
const mockDelete = vi.fn();

vi.mock("@/app/tasks/note-actions", () => ({
  listNotes: vi.fn(),
  searchNotes: (...args: unknown[]) => mockSearch(...args),
  createNote: (...args: unknown[]) => mockCreate(...args),
  editNote: (...args: unknown[]) => mockEdit(...args),
  deleteNote: (...args: unknown[]) => mockDelete(...args),
}));

afterEach(() => cleanup());

const KINEMATICS: Note = {
  id: "00000000-0000-4000-8000-000000000042",
  title: "Kinematics notes",
  content: "Forward kinematics maps joint angles to end-effector pose.",
  created_at: "2026-11-24T09:00:00Z",
  updated_at: "2026-11-24T09:00:00Z",
};
const SOURDOUGH: Note = {
  id: "00000000-0000-4000-8000-000000000043",
  title: "Sourdough",
  content: "Feed the starter every morning.",
  created_at: "2026-11-23T09:00:00Z",
  updated_at: "2026-11-23T09:00:00Z",
};

function renderBoard(initial: Note[] = [KINEMATICS, SOURDOUGH]) {
  render(<NoteBoard initial={initial} />);
}

describe("note board (M2-8b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists notes with titles and plain-text content", () => {
    renderBoard();
    expect(screen.getByText("Kinematics notes")).toBeInTheDocument();
    expect(screen.getByText("Sourdough")).toBeInTheDocument();
    expect(
      screen.getByText("Forward kinematics maps joint angles to end-effector pose."),
    ).toBeInTheDocument();
  });

  it("shows the empty state when there are no notes", () => {
    renderBoard([]);
    expect(screen.getByText("No notes yet. Add one above.")).toBeInTheDocument();
  });

  it("search returns matching notes and hides the rest", async () => {
    mockSearch.mockResolvedValue({ ok: true, data: [KINEMATICS] });
    renderBoard();
    fireEvent.change(screen.getByLabelText("Search notes"), {
      target: { value: "kinematics" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(mockSearch).toHaveBeenCalledWith("kinematics"),
    );
    expect(
      screen.getByText("1 note matches “kinematics”"),
    ).toBeInTheDocument();
    expect(screen.getByText("Kinematics notes")).toBeInTheDocument();
    expect(screen.queryByText("Sourdough")).not.toBeInTheDocument();
  });

  it("search with no matches shows the no-match state", async () => {
    mockSearch.mockResolvedValue({ ok: true, data: [] });
    renderBoard();
    fireEvent.change(screen.getByLabelText("Search notes"), {
      target: { value: "sourdough starter recipe" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(
        screen.getByText("0 notes match “sourdough starter recipe”"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("No notes match. Try other words.")).toBeInTheDocument();
  });

  it("clearing the search restores the full list", async () => {
    mockSearch.mockResolvedValue({ ok: true, data: [KINEMATICS] });
    renderBoard();
    fireEvent.change(screen.getByLabelText("Search notes"), {
      target: { value: "kinematics" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(screen.queryByText("Sourdough")).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText("Sourdough")).toBeInTheDocument();
  });

  it("creates a note only after the server confirms it", async () => {
    const created: Note = {
      id: "00000000-0000-4000-8000-000000000044",
      title: "PID notes",
      content: "Tune Kp first.",
      created_at: "2026-11-24T10:00:00Z",
      updated_at: "2026-11-24T10:00:00Z",
    };
    mockCreate.mockResolvedValue({ ok: true, data: created });
    renderBoard();
    fireEvent.click(screen.getByText("New note"));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "PID notes" },
    });
    fireEvent.change(screen.getByLabelText("Text"), {
      target: { value: "Tune Kp first." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({
        title: "PID notes",
        content: "Tune Kp first.",
      }),
    );
    expect(screen.getByText("PID notes")).toBeInTheDocument();
  });

  // Clipboard paste (Phase 1, 2026-11-25): pasting appends to the
  // new-note text field and saves nothing until "Save note".
  it("paste from clipboard appends to the new-note text", async () => {
    Object.defineProperty(window.navigator, "clipboard", {
      value: { readText: async () => "pasted content" },
      configurable: true,
    });
    try {
      renderBoard([]);
      fireEvent.click(screen.getByText("New note"));
      fireEvent.click(screen.getByRole("button", { name: "Paste from clipboard" }));
      const content = screen.getByLabelText("Text") as HTMLTextAreaElement;
      await waitFor(() => expect(content.value).toBe("pasted content"));
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      delete (window.navigator as unknown as { clipboard?: unknown }).clipboard;
    }
  });

  it("denied clipboard permission shows a message in the notes form", async () => {
    const error = new Error("Permission denied");
    error.name = "NotAllowedError";
    Object.defineProperty(window.navigator, "clipboard", {
      value: {
        readText: async () => {
          throw error;
        },
      },
      configurable: true,
    });
    try {
      renderBoard([]);
      fireEvent.click(screen.getByText("New note"));
      fireEvent.click(screen.getByRole("button", { name: "Paste from clipboard" }));
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent(
          "Clipboard access was blocked",
        ),
      );
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      delete (window.navigator as unknown as { clipboard?: unknown }).clipboard;
    }
  });

  it("edits a note only after the server confirms it", async () => {
    const edited = { ...KINEMATICS, content: "Inverse kinematics is the hard direction." };
    mockEdit.mockResolvedValue({ ok: true, data: edited });
    renderBoard();
    fireEvent.click(screen.getByRole("button", { name: "Edit Kinematics notes" }));
    fireEvent.change(
      screen.getByLabelText("Text", {
        selector: `#note-content-${KINEMATICS.id}`,
      }),
      {
        target: { value: "Inverse kinematics is the hard direction." },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockEdit).toHaveBeenCalledWith(KINEMATICS.id, {
        title: "Kinematics notes",
        content: "Inverse kinematics is the hard direction.",
      }),
    );
    expect(
      screen.getByText("Inverse kinematics is the hard direction."),
    ).toBeInTheDocument();
  });

  it("deletes after confirmation", async () => {
    mockDelete.mockResolvedValue({ ok: true, data: { id: KINEMATICS.id } });
    renderBoard();
    fireEvent.click(screen.getByRole("button", { name: "Delete Kinematics notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith(KINEMATICS.id),
    );
    expect(screen.queryByText("Kinematics notes")).not.toBeInTheDocument();
    expect(screen.getByText("Sourdough")).toBeInTheDocument();
  });

  it("a failed search shows the error and keeps the list", async () => {
    mockSearch.mockResolvedValue({ ok: false, error: "unavailable" });
    renderBoard();
    fireEvent.change(screen.getByLabelText("Search notes"), {
      target: { value: "kinematics" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not reach the database. Nothing was changed.",
      ),
    );
    expect(screen.getByText("Kinematics notes")).toBeInTheDocument();
    expect(screen.getByText("Sourdough")).toBeInTheDocument();
  });
});
