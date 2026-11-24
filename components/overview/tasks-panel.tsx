import Link from "next/link";
import { timestampToDueDay, type Task } from "@/lib/tasks";
import { formatActivityTime } from "@/lib/activity";
import { getTool } from "@/lib/tools/registry";
import type { OpenApproval } from "@/app/approvals/actions";
import { Panel, Unavailable } from "./panel";

const SHOWN = 5;

function formatDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

/** Tasks (DESIGN.md 2): pending first with due dates; completed counted. null = failed load.
 * An open approval adds the "Awaiting your approval" card at the top (DESIGN.md §2);
 * a null approvals prop means that load failed — the card is absent and the
 * Usage & Limits gauge reports it as Unavailable instead. */
export function TasksPanel({
  tasks,
  today,
  openApprovals,
}: {
  tasks: Task[] | null;
  today: string;
  openApprovals?: OpenApproval[] | null;
}) {
  const open = tasks?.filter((t) => t.status === "pending") ?? [];
  const doneCount = (tasks?.length ?? 0) - open.length;
  return (
    <Panel
      title="Tasks"
      tourId="tasks"
      action={
        <Link
          href="/tasks"
          className="flex min-h-11 items-center text-sm text-accent-cyan underline-offset-4 hover:underline"
        >
          Open
        </Link>
      }
    >
      {openApprovals && openApprovals.length > 0 ? (
        <div className="mb-3 rounded-md border border-warning/50 bg-surface-raised p-3">
          <p className="font-display text-base font-semibold tracking-[0.06em] text-warning uppercase">
            Awaiting your approval
          </p>
          {openApprovals.map((approval) => (
            <div key={approval.id} className="mt-2 flex items-center justify-between gap-3">
              <p className="min-w-0 text-sm text-text-primary">
                <span className="font-mono">
                  {getTool(approval.toolName)?.displayLabel ?? approval.toolName}
                </span>{" "}
                · proposed {formatActivityTime(approval.createdAt)}
              </p>
              <Link
                href={approval.conversationId ? `/chat?id=${approval.conversationId}` : "/chat"}
                className="flex min-h-11 shrink-0 items-center rounded-md border border-accent-cyan/30 px-3 text-sm text-accent-cyan"
              >
                Review approval
              </Link>
            </div>
          ))}
        </div>
      ) : null}
      {tasks === null ? (
        <Unavailable what="Tasks" />
      ) : tasks.length === 0 ? (
        <p className="text-sm text-text-secondary">No tasks yet.</p>
      ) : (
        <>
          {open.length === 0 ? (
            <p className="text-sm text-text-secondary">Nothing pending.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {open.slice(0, SHOWN).map((task) => {
                const day = timestampToDueDay(task.due_date);
                const overdue = day !== "" && day < today;
                return (
                  <li
                    key={task.id}
                    className={`flex items-center gap-3 rounded border bg-surface-raised/70 px-3 py-2 ${overdue ? "border-danger/50" : "border-border"}`}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                      className={`size-5 shrink-0 ${overdue ? "text-danger" : "text-accent-deep"}`}
                    >
                      <circle cx="12" cy="12" r="9" />
                    </svg>
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className={`block text-sm ${overdue ? "text-danger" : "text-text-secondary"}`}>
                        {overdue ? `Overdue · ${formatDay(day)}:` : day ? `Pending · Due ${formatDay(day)}:` : "Pending:"}
                      </span>
                      <span className="block text-lg break-words">{task.title}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-2 flex items-center gap-3 rounded border border-border bg-surface-raised/70 px-3 py-2">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
              className="size-5 shrink-0 text-success"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="m8.5 12.5 2.5 2.5 4.5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="leading-tight">
              <span className="block text-sm text-text-secondary">Completed:</span>
              <span className="block text-lg">
                {doneCount} completed
                {open.length > SHOWN ? ` · ${open.length - SHOWN} more pending` : ""}
              </span>
            </span>
          </p>
        </>
      )}
    </Panel>
  );
}
