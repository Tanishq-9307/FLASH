// Tasks screen (M2-8a, DESIGN.md §5.1). The board loads its rows from
// the database through listTasks; a failed load shows "Unavailable",
// never an empty list pretending there are no tasks (DESIGN.md §9).
// The Notes half of this screen arrives in M2-8b.
import { TaskBoard } from "@/components/task-board";
import { listTasks } from "./actions";
import { usageDateToday } from "@/lib/config";

export const metadata = { title: "Tasks & Notes · FLASH" };

export default async function TasksPage() {
  const tasks = await listTasks();
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-6">
      <h1 className="font-display text-3xl font-semibold uppercase tracking-[0.06em] text-text-primary">
        Tasks &amp; Notes
      </h1>
      {tasks.ok ? (
        <TaskBoard initial={tasks.data} today={usageDateToday()} />
      ) : (
        <p role="alert" className="flash-frame p-4 text-danger">
          Tasks unavailable. Could not load them from the database.
        </p>
      )}
    </div>
  );
}
