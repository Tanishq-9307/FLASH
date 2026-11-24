// Overview (M2-9a, DESIGN.md §2/§5). The home screen: three-zone layout,
// orb centre, Usage & Limits, Recent Notes, Tasks, Quick Actions. Every
// panel takes its data through props; a failed load passes null, which the
// panel renders as "Unavailable", never a zero (DESIGN.md §9). M3-24b
// wires the open-approvals gauge and memory state into Usage & Limits,
// the "Awaiting your approval" card into Tasks, the Review approval quick
// action, the registry capability chips under the orb, and the Activity
// panel from action_logs. The UsagePanel fetches today's real figures
// from /api/health in the browser, and the Tasks-done gauge gets its tally
// from the same real task list (M2-9b).
import { Overview } from "@/components/overview/overview";
import { UsagePanel } from "@/components/overview/usage-panel";
import { listTasks } from "@/app/tasks/actions";
import { listNotes } from "@/app/tasks/note-actions";
import { listOpenApprovals } from "@/app/approvals/actions";
import { listActivity } from "@/app/activity/actions";
import { getMemoryEnabled } from "@/app/memory/actions";
import { getCapabilityChips } from "@/lib/tools/registry";
import { usageDateToday } from "@/lib/config";

export const metadata = { title: "Overview · FLASH" };

export default async function Home() {
  const [tasks, notes, approvals, activity, memory] = await Promise.all([
    listTasks(),
    listNotes(),
    listOpenApprovals(),
    listActivity(),
    getMemoryEnabled(),
  ]);
  const tally = tasks.ok
    ? { done: tasks.data.filter((t) => t.status === "completed").length, total: tasks.data.length }
    : null;
  const openApprovals = approvals.ok ? approvals.data : null;
  return (
    <Overview
      usage={
        <UsagePanel
          tasks={tally}
          openApprovals={openApprovals === null ? null : openApprovals.length}
          memoryEnabled={memory.ok ? memory.data : null}
        />
      }
      tasks={tasks.ok ? tasks.data : null}
      notes={notes.ok ? notes.data : null}
      today={usageDateToday()}
      openApprovals={openApprovals}
      activity={activity.ok ? activity.data : null}
      chips={getCapabilityChips()}
    />
  );
}
