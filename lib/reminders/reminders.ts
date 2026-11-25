// Reminders — shared types, validation and formatting (Phase 3,
// 2026-11-25). Free of Next.js and Supabase imports so the pure
// functions can be unit-tested without mocks. Time parsing lives in
// ./parse-time.ts; delivery in lib/telegram/run-reminders.ts.
//
// Validation limits equal the database CHECKs: message 1–500
// characters, status pending/sending/sent/cancelled, source
// web/chat/telegram.
import { z } from "zod";
import { formatReminderTime } from "./parse-time";

/** DATABASE.md: reminders.message CHECK (1–500 characters). */
export const MAX_REMINDER_MESSAGE = 500;

export const REMINDER_STATUSES = [
  "pending",
  "sending",
  "sent",
  "cancelled",
] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

export const REMINDER_SOURCES = ["web", "chat", "telegram"] as const;
export type ReminderSource = (typeof REMINDER_SOURCES)[number];

export type Reminder = {
  id: string;
  user_id: string;
  message: string;
  remind_at: string;
  status: string;
  source: string;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
};

const reminderIdSchema = z.string().uuid();

const reminderMessageSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, " ").trim())
  .pipe(z.string().min(1).max(MAX_REMINDER_MESSAGE));

const reminderAtSchema = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), {
    message: "remind_at must be an ISO 8601 date or timestamp",
  });

/** A reminder as the web form submits it: a message and a
 * datetime-local value ("2026-11-26T09:00"). */
export const reminderInputSchema = z.object({
  message: reminderMessageSchema,
  remindAt: reminderAtSchema,
});
export type ReminderInput = z.input<typeof reminderInputSchema>;

export { reminderIdSchema };

/** A datetime-local value ("2026-11-26T09:00") is a wall-clock
 * reading in India (the owner's time zone): interpret it as
 * Asia/Kolkata, i.e. UTC+5:30. */
export function datetimeLocalToTimestamp(value: string): string {
  return `${value}:00+05:30`;
}

/** Pending first (soonest first), then sent, then cancelled — so
 * the list shows what still matters at the top. */
export function sortReminders(reminders: Reminder[]): Reminder[] {
  const rank = (status: string): number => {
    if (status === "pending" || status === "sending") return 0;
    if (status === "sent") return 1;
    return 2;
  };
  return [...reminders].sort((a, b) => {
    const ra = rank(a.status);
    const rb = rank(b.status);
    if (ra !== rb) return ra - rb;
    if (a.remind_at !== b.remind_at) return a.remind_at < b.remind_at ? -1 : 1;
    return a.created_at < b.created_at ? 1 : -1;
  });
}

/** The exact text sent over Telegram when a reminder fires. */
export function formatReminderDelivery(reminder: Reminder): string {
  return `⏰ Reminder: ${reminder.message}`;
}

/** Pending reminders as a Telegram reply: at most 10, soonest
 * first, with the time in India. An empty list says so plainly
 * instead of inventing reminders. */
export function formatReminderList(reminders: Reminder[]): string {
  const pending = sortReminders(
    reminders.filter((r) => r.status === "pending" || r.status === "sending"),
  );
  if (pending.length === 0) return "No pending reminders.";
  const shown = pending.slice(0, 10);
  const lines = shown.map(
    (r) => `• ${r.message} — ${formatReminderTime(r.remind_at)}`,
  );
  const more =
    pending.length > shown.length
      ? `\n…and ${pending.length - shown.length} more.`
      : "";
  return `Pending reminders:\n${lines.join("\n")}${more}`;
}

/** One reminder as a line for the web list: message + time + status. */
export function formatReminderLine(reminder: Reminder): string {
  return `${reminder.message} — ${formatReminderTime(reminder.remind_at)}`;
}
