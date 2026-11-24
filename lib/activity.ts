// Activity timeline rules (M3-22, DESIGN.md §5.6, DATABASE.md §3.9).
// Pure helpers so the component and its tests share one definition of
// each status and of what counts as a tamper row. Free of Next.js and
// Supabase imports.
export type ActivityLogRow = {
  id: string;
  tool_name: string;
  parameters: unknown;
  execution_status: string;
  result_payload: unknown;
  created_at: string;
  approval_id: string | null;
  conversation_id: string | null;
};

export const ACTIVITY_STATUSES = [
  "succeeded",
  "failed",
  "not_executed",
  "unknown",
  "pending",
] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

/** Most rows the timeline ever loads (M3-22). Lives here, not in the
 * Server Action module: "use server" files may only export async
 * functions, so a shared constant breaks the production build. */
export const ACTIVITY_LIMIT = 100;

/** Icon (text glyph, never colour alone), label, and colour class per status. */
export function statusMeta(status: string): {
  icon: string;
  label: string;
  className: string;
} {
  switch (status) {
    case "succeeded":
      return { icon: "✓", label: "Succeeded", className: "text-success" };
    case "failed":
      return { icon: "✕", label: "Failed", className: "text-danger" };
    case "not_executed":
      return { icon: "⊘", label: "Not executed", className: "text-text-muted" };
    case "unknown":
      return { icon: "?", label: "Unknown", className: "text-info" };
    case "pending":
      return { icon: "◌", label: "Pending", className: "text-text-muted" };
    default:
      return { icon: "?", label: "Unknown", className: "text-info" };
  }
}

/** A row flags tamper when its result_payload says so (DATABASE.md
 * §3.9: record_claim_failure settles the log with tamper: true). */
export function isTamperRow(row: ActivityLogRow): boolean {
  return (
    typeof row.result_payload === "object" &&
    row.result_payload !== null &&
    (row.result_payload as { tamper?: unknown }).tamper === true
  );
}

/** The human-readable reason for a failed or refused row, if the
 * payload carries one (reason from a claim failure, error from an
 * execution failure). */
export function reasonOf(row: ActivityLogRow): string | null {
  if (typeof row.result_payload !== "object" || row.result_payload === null) return null;
  const payload = row.result_payload as Record<string, unknown>;
  for (const key of ["reason", "error"]) {
    const value = payload[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

/** Timestamp in the owner's time zone (Asia/Kolkata), for display. */
export function formatActivityTime(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}
