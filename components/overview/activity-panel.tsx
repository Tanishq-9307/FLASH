// Activity panel (M3-24b, DESIGN.md §2/§5.6): the latest tool calls
// on the Overview, backed by action_logs. The full timeline lives on
// /activity. A null rows prop means the load failed: "Unavailable",
// never an empty list pretending nothing happened.
import Link from "next/link";
import { formatActivityTime, isTamperRow, statusMeta, type ActivityLogRow } from "@/lib/activity";
import { Panel, Unavailable } from "./panel";

const SHOWN = 5;

export function ActivityPanel({ rows }: { rows: ActivityLogRow[] | null }) {
  return (
    <Panel
      title="Activity"
      tourId="activity"
      action={
        <Link
          href="/activity"
          className="flex min-h-11 items-center text-sm text-accent-cyan underline-offset-4 hover:underline"
        >
          View all
        </Link>
      }
    >
      {rows === null ? (
        <Unavailable what="Activity" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-text-secondary">No activity yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.slice(0, SHOWN).map((row) => {
            const meta = statusMeta(row.execution_status);
            const tamper = isTamperRow(row);
            return (
              <li
                key={row.id}
                className={`flex items-center gap-3 rounded border px-3 py-2 ${
                  tamper
                    ? "border-danger/50 bg-surface-raised/70"
                    : "border-border bg-surface-raised/70"
                }`}
              >
                <span aria-hidden="true" className={`text-base ${meta.className}`}>
                  {meta.icon}
                </span>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate font-mono text-sm text-text-primary">
                    {row.tool_name}
                  </span>
                  <span className="block text-xs text-text-secondary">
                    {meta.label}
                    {tamper ? " · Possible tamper" : ""}
                  </span>
                </span>
                <time className="shrink-0 text-xs text-text-muted">
                  {formatActivityTime(row.created_at)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
