// @vitest-environment jsdom
// Reminder board tests (Phase 3): create, cancel, delete, empty and
// error states. The Server Actions are mocked.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReminderBoard } from "@/components/reminder-board";
import type { Reminder } from "@/lib/reminders/reminders";

const mockCreate = vi.fn();
const mockCancel = vi.fn();
const mockDelete = vi.fn();

vi.mock("@/app/reminders/actions", () => ({
  createReminder: (...args: unknown[]) => mockCreate(...args),
  cancelReminder: (...args: unknown[]) => mockCancel(...args),
  deleteReminder: (...args: unknown[]) => mockDelete(...args),
}));

afterEach(() => cleanup());

const PENDING: Reminder = {
  id: "00000000-0000-4000-8000-000000000042",
  user_id: "00000000-0000-4000-8000-000000000002",
  message: "Submit the form",
  remind_at: "2026-11-26T03:30:00.000Z",
  status: "pending",
  source: "web",
  sent_at: null,
  created_at: "2026-11-25T03:00:00.000Z",
  updated_at: "2026-11-25T03:00:00.000Z",
};
const SENT: Reminder = {
  ...PENDING,
  id: "00000000-0000-4000-8000-000000000043",
  message: "Call the lab",
  remind_at: "2026-11-25T03:30:00.000Z",
  status: "sent",
  sent_at: "2026-11-25T03:30:00.000Z",
  source: "telegram",
};

function renderBoard(initial: Reminder[] = [PENDING, SENT]) {
  render(<ReminderBoard initial={initial} />);
}

describe("reminder board (Phase 3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists pending and sent sections with India times", () => {
    renderBoard();
    expect(screen.getByText("Pending (1)")).toBeInTheDocument();
    expect(screen.getByText("Sent (1)")).toBeInTheDocument();
    expect(screen.getByText("Submit the form")).toBeInTheDocument();
    expect(screen.getByText("Call the lab")).toBeInTheDocument();
    expect(screen.getByText(/26 Nov 2026, 9:00 am/)).toBeInTheDocument();
    expect(screen.getByText(/via Telegram/)).toBeInTheDocument();
  });

  it("shows the empty state when there are no reminders", () => {
    renderBoard([]);
    expect(screen.getByText(/No reminders yet/)).toBeInTheDocument();
  });

  it("creates a reminder with the time read as India time", async () => {
    const created: Reminder = {
      ...PENDING,
      id: "00000000-0000-4000-8000-000000000044",
      message: "File the report",
      remind_at: "2026-11-26T03:30:00.000Z",
    };
    mockCreate.mockResolvedValue({ ok: true, data: created });
    renderBoard([]);
    fireEvent.change(screen.getByLabelText("Remind me about"), {
      target: { value: "File the report" },
    });
    fireEvent.change(screen.getByLabelText("Date and time"), {
      target: { value: "2026-11-26T09:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith({
      message: "File the report",
      remindAt: "2026-11-26T09:00:00+05:30",
    }));
    expect(await screen.findByText("File the report")).toBeInTheDocument();
  });

  it("shows the server error when creation fails", async () => {
    mockCreate.mockResolvedValue({ ok: false, error: "invalid" });
    renderBoard([]);
    fireEvent.change(screen.getByLabelText("Remind me about"), {
      target: { value: "Hi" },
    });
    fireEvent.change(screen.getByLabelText("Date and time"), {
      target: { value: "2026-11-26T09:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    expect(
      await screen.findByText(/needs a message.*future date and time/),
    ).toBeInTheDocument();
  });

  it("cancels a pending reminder and deletes a sent one", async () => {
    mockCancel.mockResolvedValue({
      ok: true,
      data: { ...PENDING, status: "cancelled" },
    });
    mockDelete.mockResolvedValue({
      ok: true,
      data: { id: SENT.id },
    });
    renderBoard();
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel reminder: Submit the form" }),
    );
    await waitFor(() =>
      expect(mockCancel).toHaveBeenCalledWith(PENDING.id),
    );
    expect(await screen.findByText("Cancelled (1)")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete reminder: Call the lab" }),
    );
    await waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith(SENT.id),
    );
    expect(screen.queryByText("Call the lab")).not.toBeInTheDocument();
  });
});
