// Activity timeline (M3-22, DESIGN.md §5.6/§9). Props-driven: rows from
// action_logs, each with an icon and text status, timestamp, tool name,
// and expandable parameters (plain text in mono — React escapes them,
// so HTML in a parameter is shown literally). Tamper rows get a danger
// left border, a warning icon, and the text "Possible tamper". A null
// rows prop means the load failed: "Unavailable", never an empty list
// pretending nothing happened.
"use client";

import { useMemo, useState } from "react";
import {
  ACTIVITY_STATUSES,
  formatActivityTime,
  isTamperRow,
  reasonOf,
  statusMeta,
  type ActivityLogRow,
} from "@/lib/activity";

function ActivityRow({ row }: { row: ActivityLogRow }) {
  const [open, setOpen] = useState(false);
  const meta = statusMeta(row.execution_status);
  const tamper = isTamperRow(row);
  const reason = reasonOf(row);
  return (
    <article
      className={`rounded-md border bg-surface p-3 ${
        tamper ? "border-l-4 border-danger border-l-danger" : "border-border"
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={`font-mono text-sm font-semibold ${meta.className}`} aria-hidden="true">
          {meta.icon}
        </span>
        <span className={`text-sm font-semibold ${meta.className}`}>{meta.label}</span>
        <span className="font-mono text-sm text-text-primary">{row.tool_name}</span>
        <time dateTime={row.created_at} className="ml-auto font-mono text-xs text-text-muted">
          {formatActivityTime(row.created_at)}
        </time>
      </div>
      {tamper ? (
        <p className="mt-2 flex items-center gap-2 text-sm font-semibold text-danger">
          <span aria-hidden="true">⚠</span> Possible tamper
        </p>
      ) : null}
      {reason ? <p className="mt-1 text-sm text-text-secondary">{reason}</p> : null}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="mt-2 min-h-11 px-1 font-mono text-xs text-accent-cyan underline"
      >
        {open ? "Hide parameters" : "Show parameters"}
      </button>
      {open ? (
        <pre className="mt-2 overflow-x-auto rounded-md bg-surface-raised p-3 font-mono text-xs whitespace-pre-wrap text-text-primary">
          {JSON.stringify(row.parameters, null, 2)}
        </pre>
      ) : null}
    </article>
  );
}

export function ActivityTimeline({ rows }: { rows: ActivityLogRow[] | null }) {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [toolFilter, setToolFilter] = useState<string>("all");
  const [tamperOnly, setTamperOnly] = useState(false);

  const tools = useMemo(
    () => [...new Set((rows ?? []).map((row) => row.tool_name))].sort(),
    [rows],
  );

  const filtered = useMemo(
    () =>
      (rows ?? []).filter(
        (row) =>
          (statusFilter === "all" || row.execution_status === statusFilter) &&
          (toolFilter === "all" || row.tool_name === toolFilter) &&
          (!tamperOnly || isTamperRow(row)),
      ),
    [rows, statusFilter, toolFilter, tamperOnly],
  );

  if (rows === null) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-6">
        <h1 className="font-display text-2xl font-semibold">Activity</h1>
        <p role="alert" className="mt-4 text-sm text-text-secondary">
          Activity is Unavailable. The log could not be loaded.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <h1 className="font-display text-2xl font-semibold">Activity</h1>
      <p className="mt-1 text-sm text-text-secondary">
        Every tool call FLASH has made, with its real outcome from the database.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="activity-status" className="font-mono text-xs text-text-secondary uppercase">
            Status
          </label>
          <select
            id="activity-status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className="min-h-11 rounded-md border border-border-strong bg-surface px-2 text-sm text-text-primary"
          >
            <option value="all">All statuses</option>
            {ACTIVITY_STATUSES.map((status) => (
              <option key={status} value={status}>
                {statusMeta(status).label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="activity-tool" className="font-mono text-xs text-text-secondary uppercase">
            Tool
          </label>
          <select
            id="activity-tool"
            value={toolFilter}
            onChange={(event) => setToolFilter(event.target.value)}
            className="min-h-11 rounded-md border border-border-strong bg-surface px-2 text-sm text-text-primary"
          >
            <option value="all">All tools</option>
            {tools.map((tool) => (
              <option key={tool} value={tool}>
                {tool}
              </option>
            ))}
          </select>
        </div>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-text-primary">
          <input
            type="checkbox"
            checked={tamperOnly}
            onChange={(event) => setTamperOnly(event.target.checked)}
            className="size-4 accent-[#00e5ff]"
          />
          Tamper flags only
        </label>
      </div>

      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-text-secondary">
          No activity yet. Tool calls and approvals will appear here.
        </p>
      ) : filtered.length === 0 ? (
        <p className="mt-6 text-sm text-text-secondary">
          No activity matches these filters.
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {filtered.map((row) => (
            <ActivityRow key={row.id} row={row} />
          ))}
        </div>
      )}
    </main>
  );
}
