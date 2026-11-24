// Tasks & Notes screen (M2-8a, M2-8b, DESIGN.md §5.1). Both boards load
// their rows from the database; a failed load shows "Unavailable" for
// that half, never an empty list pretending there is nothing there
// (DESIGN.md §9).
import { TaskBoard } from "@/components/task-board";
import { NoteBoard } from "@/components/note-board";
import { listTasks } from "./actions";
import { listNotes } from "./note-actions";
import { usageDateToday } from "@/lib/config";

export const metadata = { title: "Tasks & Notes · FLASH" };

function Unavailable({ what }: { what: string }) {
  return (
    <p role="alert" className="flash-frame p-4 text-danger">
      {what} unavailable. Could not load them from the database.
    </p>
  );
}

export default async function TasksPage() {
  const [tasks, notes] = await Promise.all([listTasks(), listNotes()]);
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-6">
      <h1 className="font-display text-3xl font-semibold uppercase tracking-[0.06em] text-text-primary">
        Tasks &amp; Notes
      </h1>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {tasks.ok ? (
          <TaskBoard initial={tasks.data} today={usageDateToday()} />
        ) : (
          <Unavailable what="Tasks" />
        )}
        {notes.ok ? (
          <NoteBoard initial={notes.data} />
        ) : (
          <Unavailable what="Notes" />
        )}
      </div>
    </div>
  );
}
