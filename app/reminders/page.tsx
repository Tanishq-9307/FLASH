// Reminders screen (Phase 3, 2026-11-25, DESIGN.md §5.1). Rows
// load from the database; a failed load shows "Unavailable", never
// an empty list pretending there is nothing there (DESIGN.md §9).
import { ReminderBoard } from "@/components/reminder-board";
import { listReminders } from "./actions";

export const metadata = { title: "Reminders · FLASH" };

export default async function RemindersPage() {
  const reminders = await listReminders();
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-6">
      <h1 className="font-display text-3xl font-semibold uppercase tracking-[0.06em] text-text-primary">
        Reminders
      </h1>
      {reminders.ok ? (
        <ReminderBoard initial={reminders.data} />
      ) : (
        <p role="alert" className="flash-frame p-4 text-danger">
          Reminders unavailable. Could not load them from the database.
        </p>
      )}
    </div>
  );
}
