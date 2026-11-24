// Overview (M2-9a, DESIGN.md §2/§5). The home screen: three-zone layout,
// orb centre, Usage & Limits, Recent Notes, Tasks, Quick Actions. Every
// panel takes its data through props; a failed load passes null, which the
// panel renders as "Unavailable", never a zero (DESIGN.md §9). M3-dependent
// panels (open approvals, capability chips, activity) stay hidden until
// M3-24b. The UsagePanel fetches today's real figures from /api/health in
// the browser; the Tasks-done gauge is wired to the real task list in M2-9b.
import { Overview } from "@/components/overview/overview";
import { UsagePanel } from "@/components/overview/usage-panel";
import { listTasks } from "@/app/tasks/actions";
import { listNotes } from "@/app/tasks/note-actions";
import { usageDateToday } from "@/lib/config";

export const metadata = { title: "Overview · FLASH" };

export default async function Home() {
  const [tasks, notes] = await Promise.all([listTasks(), listNotes()]);
  return (
    <Overview
      usage={<UsagePanel />}
      tasks={tasks.ok ? tasks.data : null}
      notes={notes.ok ? notes.data : null}
      today={usageDateToday()}
    />
  );
}
