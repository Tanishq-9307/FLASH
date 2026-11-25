// @vitest-environment jsdom
// Task board tests (M2-8a): create, complete, edit, delete, empty and
// error states, overdue marking. The Server Actions are mocked.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskBoard } from "@/components/task-board";
import type { Task } from "@/lib/tasks";

const mockCreate = vi.fn();
const mockEdit = vi.fn();
const mockSetStatus = vi.fn();
const mockDelete = vi.fn();

vi.mock("@/app/tasks/actions", () => ({
  createTask: (...args: unknown[]) => mockCreate(...args),
  editTask: (...args: unknown[]) => mockEdit(...args),
  setTaskStatus: (...args: unknown[]) => mockSetStatus(...args),
  deleteTask: (...args: unknown[]) => mockDelete(...args),
}));

afterEach(() => cleanup());

const PENDING: Task = {
  id: "00000000-0000-4000-8000-000000000042",
  title: "Buy milk",
  due_date: "2026-11-20T00:00:00+05:30",
  status: "pending",
  created_at: "2026-11-24T09:00:00Z",
  updated_at: "2026-11-24T09:00:00Z",
};
const DONE: Task = {
  id: "00000000-0000-4000-8000-000000000043",
  title: "File report",
  due_date: null,
  status: "completed",
  created_at: "2026-11-23T09:00:00Z",
  updated_at: "2026-11-23T09:00:00Z",
};

function renderBoard(initial: Task[] = [PENDING, DONE]) {
  render(<TaskBoard initial={initial} today="2026-11-24" />);
}

describe("task board (M2-8a)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists pending and completed sections and marks the overdue task", () => {
    renderBoard();
    expect(screen.getByText("To do (1)")).toBeInTheDocument();
    expect(screen.getByText("Completed (1)")).toBeInTheDocument();
    expect(screen.getByText("Buy milk")).toBeInTheDocument();
    expect(screen.getByText("File report")).toBeInTheDocument();
    expect(screen.getByText(/Overdue/)).toHaveTextContent("Overdue · 20 Nov 2026");
  });

  it("shows the empty state when there are no tasks", () => {
    renderBoard([]);
    expect(screen.getByText("No tasks yet. Add one above.")).toBeInTheDocument();
  });

  it("creates a task only after the server confirms it", async () => {
    const created: Task = {
      id: "00000000-0000-4000-8000-000000000044",
      title: "Water plants",
      due_date: null,
      status: "pending",
      created_at: "2026-11-24T10:00:00Z",
      updated_at: "2026-11-24T10:00:00Z",
    };
    mockCreate.mockResolvedValue({ ok: true, data: created });
    renderBoard();
    fireEvent.change(screen.getByLabelText("New task"), {
      target: { value: "Water plants" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({ title: "Water plants", dueDay: "" }),
    );
    expect(screen.getByText("Water plants")).toBeInTheDocument();
    expect(screen.getByLabelText("New task")).toHaveValue("");
  });

  it("shows the create error and keeps the typed title", async () => {
    mockCreate.mockResolvedValue({ ok: false, error: "unavailable" });
    renderBoard();
    fireEvent.change(screen.getByLabelText("New task"), {
      target: { value: "Water plants" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not reach the database. Nothing was changed.",
      ),
    );
    expect(screen.queryByText("Water plants")).not.toBeInTheDocument();
    expect(screen.getByLabelText("New task")).toHaveValue("Water plants");
  });

  // Clipboard paste (Phase 1, 2026-11-25): pasting appends to the
  // new-task title field and creates nothing until "Add task".
  it("paste from clipboard appends to the new-task title", async () => {
    Object.defineProperty(window.navigator, "clipboard", {
      value: { readText: async () => "pasted task" },
      configurable: true,
    });
    try {
      renderBoard([]);
      fireEvent.click(screen.getByRole("button", { name: "Paste from clipboard" }));
      const title = screen.getByLabelText("New task") as HTMLInputElement;
      await waitFor(() => expect(title.value).toBe("pasted task"));
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      delete (window.navigator as unknown as { clipboard?: unknown }).clipboard;
    }
  });

  it("denied clipboard permission shows a message in the task form", async () => {
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

  it("completing a task calls setTaskStatus and moves it", async () => {
    mockSetStatus.mockResolvedValue({
      ok: true,
      data: { ...PENDING, status: "completed" },
    });
    renderBoard();
    const checkbox = screen.getByRole("checkbox", { name: /Buy milk/ });
    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(mockSetStatus).toHaveBeenCalledWith(PENDING.id, "completed"),
    );
    expect(screen.getByText("Completed (2)")).toBeInTheDocument();
  });

  it("edits a task only after the server confirms it", async () => {
    const edited = { ...PENDING, title: "Buy oat milk" };
    mockEdit.mockResolvedValue({ ok: true, data: edited });
    renderBoard();
    fireEvent.click(screen.getByRole("button", { name: "Edit Buy milk" }));
    fireEvent.change(screen.getByLabelText("Task title"), {
      target: { value: "Buy oat milk" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));
    await waitFor(() =>
      expect(mockEdit).toHaveBeenCalledWith(PENDING.id, {
        title: "Buy oat milk",
        dueDay: "2026-11-20",
      }),
    );
    expect(screen.getByText("Buy oat milk")).toBeInTheDocument();
  });

  it("deletes after confirmation", async () => {
    mockDelete.mockResolvedValue({ ok: true, data: { id: PENDING.id } });
    renderBoard();
    fireEvent.click(screen.getByRole("button", { name: "Delete Buy milk" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith(PENDING.id),
    );
    expect(screen.queryByText("Buy milk")).not.toBeInTheDocument();
    expect(screen.getByText("File report")).toBeInTheDocument();
  });

  it("a failed delete shows the error and keeps the task", async () => {
    mockDelete.mockResolvedValue({ ok: false, error: "not_found" });
    renderBoard();
    fireEvent.click(screen.getByRole("button", { name: "Delete Buy milk" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "That task no longer exists.",
      ),
    );
    expect(screen.getByText("Buy milk")).toBeInTheDocument();
  });
});
