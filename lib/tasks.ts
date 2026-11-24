// Tasks rules (M2-8a, DATABASE.md §3.5). Validation limits equal the
// database CHECKs: title 1–255 characters, status pending/completed.
// A due day from <input type="date"> means midnight at the start of
// that day in India (the owner's time zone); an empty day means no due
// date. Free of Next.js and Supabase imports so the pure functions can
// be unit-tested without mocks.
import { z } from "zod";

/** DATABASE.md §3.5: tasks.title CHECK (char_length(title) <= 255). */
export const MAX_TASK_TITLE = 255;

export const TASK_STATUSES = ["pending", "completed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type Task = {
  id: string;
  title: string;
  due_date: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

const taskIdSchema = z.string().uuid();

const taskTitleSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, " ").trim())
  .pipe(z.string().min(1).max(MAX_TASK_TITLE));

// A calendar day from <input type="date">, or empty for "no due date".
const dueDaySchema = z.union([z.literal(""), z.iso.date()]);

export const taskInputSchema = z.object({
  title: taskTitleSchema,
  dueDay: dueDaySchema,
});
export type TaskInput = z.input<typeof taskInputSchema>;

export const taskStatusSchema = z.enum(TASK_STATUSES);

export { taskIdSchema };

/** A due day means midnight at the start of that day in India. */
export function dueDayToTimestamp(day: string): string | null {
  return day ? `${day}T00:00:00+05:30` : null;
}

/** The calendar day (YYYY-MM-DD, Asia/Kolkata) of a stored due date. */
export function timestampToDueDay(timestamp: string | null): string {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

/** Pending first, then by due day (no date last), then newest. */
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.status !== b.status) return a.status === "pending" ? -1 : 1;
    const ad = a.due_date ?? "9999";
    const bd = b.due_date ?? "9999";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.created_at < b.created_at ? 1 : -1;
  });
}
