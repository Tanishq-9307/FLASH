// Reminder domain tests (Phase 3): validation limits equal the
// database CHECKs, sorting, formatting, and the datetime-local
// conversion (a wall-clock reading in India, not UTC).
import { describe, expect, it } from "vitest";
import {
  datetimeLocalToTimestamp,
  formatReminderDelivery,
  formatReminderList,
  reminderInputSchema,
  sortReminders,
  type Reminder,
} from "@/lib/reminders/reminders";

function reminder(partial: Partial<Reminder> = {}): Reminder {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    user_id: "00000000-0000-4000-8000-000000000002",
    message: "Submit the form",
    remind_at: "2026-11-26T03:30:00.000Z",
    status: "pending",
    source: "web",
    sent_at: null,
    created_at: "2026-11-25T03:00:00.000Z",
    updated_at: "2026-11-25T03:00:00.000Z",
    ...partial,
  };
}

describe("reminderInputSchema", () => {
  it("accepts a message and an ISO remind_at", () => {
    const parsed = reminderInputSchema.safeParse({
      message: "  Submit the form  ",
      remindAt: "2026-11-26T03:30:00.000Z",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message).toBe("Submit the form");
    }
  });

  it("rejects an empty, over-long, or unparseable input", () => {
    expect(
      reminderInputSchema.safeParse({ message: "   ", remindAt: "2026-11-26T03:30:00Z" })
        .success,
    ).toBe(false);
    expect(
      reminderInputSchema.safeParse({
        message: "x".repeat(501),
        remindAt: "2026-11-26T03:30:00Z",
      }).success,
    ).toBe(false);
    expect(
      reminderInputSchema.safeParse({ message: "Hi", remindAt: "tomorrow" })
        .success,
    ).toBe(false);
  });
});

describe("datetimeLocalToTimestamp", () => {
  it("reads a datetime-local value as Asia/Kolkata, not UTC", () => {
    expect(datetimeLocalToTimestamp("2026-11-26T09:00")).toBe(
      "2026-11-26T09:00:00+05:30",
    );
    expect(
      new Date(datetimeLocalToTimestamp("2026-11-26T09:00")).toISOString(),
    ).toBe("2026-11-26T03:30:00.000Z");
  });
});

describe("sortReminders", () => {
  it("puts pending soonest-first, then sent, then cancelled", () => {
    const rows = [
      reminder({ id: "a", status: "sent", remind_at: "2026-11-25T03:30:00Z" }),
      reminder({ id: "b", status: "pending", remind_at: "2026-11-27T03:30:00Z" }),
      reminder({ id: "c", status: "pending", remind_at: "2026-11-26T03:30:00Z" }),
      reminder({ id: "d", status: "cancelled", remind_at: "2026-11-24T03:30:00Z" }),
    ];
    expect(sortReminders(rows).map((r) => r.id)).toEqual(["c", "b", "a", "d"]);
  });
});

describe("formatReminderDelivery and formatReminderList", () => {
  it("delivers the exact message, nothing invented", () => {
    expect(formatReminderDelivery(reminder())).toBe(
      "⏰ Reminder: Submit the form",
    );
  });

  it("lists pending reminders soonest-first with India times", () => {
    const list = formatReminderList([
      reminder({ message: "Call the lab", remind_at: "2026-11-27T04:30:00Z" }),
      reminder({ message: "Submit the form", remind_at: "2026-11-26T03:30:00Z" }),
      reminder({ message: "Done one", status: "sent" }),
    ]);
    expect(list).toContain("Submit the form — 26 Nov 2026, 9:00 am");
    expect(list).toContain("Call the lab — 27 Nov 2026, 10:00 am");
    expect(list).not.toContain("Done one");
    expect(list.indexOf("Submit the form")).toBeLessThan(
      list.indexOf("Call the lab"),
    );
  });

  it("says plainly when there are no pending reminders", () => {
    expect(formatReminderList([])).toBe("No pending reminders.");
    expect(formatReminderList([reminder({ status: "cancelled" })])).toBe(
      "No pending reminders.",
    );
  });
});
