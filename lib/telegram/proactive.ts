// Proactive engine — evaluation (Phase 3, 2026-11-25). Pure functions:
// given real state (tasks, usage, the time), decide which nudges, if
// any, are worth sending. No network, no database, no sending here —
// lib/telegram/run-proactive.ts loads the state and does the sending.
//
// Honest-data rule: every nudge names a real row (a real overdue or
// due-today task, a real usage count). Nothing is invented, nothing is
// urgent unless it really is overdue. The same nudge is never sent
// twice: each nudge carries a stable key (task id + day, or usage +
// day) and the runner only sends keys with no row in telegram_nudges.
import type { Task } from "@/lib/tasks";
import { usageDateToday } from "@/lib/config";

/** At most this many nudges go out in one scheduled run. */
export const MAX_PROACTIVE_NUDGES_PER_RUN = 3;

/** Usage percentage that earns a nudge (the meter is a display limit,
 * so this is a heads-up, not a block). */
export const PROACTIVE_USAGE_THRESHOLD_PERCENT = 80;

/** Quiet hours (Asia/Kolkata): no nudge is ever sent between 23:00
 * and 07:00 — a nudge that wakes the owner is a bug, not a feature. */
export const PROACTIVE_QUIET_START_HOUR = 23;
export const PROACTIVE_QUIET_END_HOUR = 7;

export type ProactiveNudgeKind = "overdue_task" | "due_today" | "high_usage";

export interface ProactiveNudge {
  /** Stable dedupe key: same real-world fact, same key, forever. */
  key: string;
  kind: ProactiveNudgeKind;
  /** The exact text to send. */
  text: string;
}

/** The Asia/Kolkata hour (0–23) of a moment. */
export function kolkataHour(now: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      hour12: false,
    }).format(now),
  );
}

/** True during quiet hours (23:00–07:00 IST). */
export function isQuietHours(now: Date): boolean {
  const hour = kolkataHour(now);
  return hour >= PROACTIVE_QUIET_START_HOUR || hour < PROACTIVE_QUIET_END_HOUR;
}

/** The calendar day (YYYY-MM-DD, Asia/Kolkata) a task is due on. */
function dueDayOf(task: Task): string | null {
  if (!task.due_date) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(task.due_date));
}

/** Evaluate real state into nudges, most urgent first: overdue tasks
 * (one nudge each, oldest due first), then tasks due today (one
 * combined nudge), then high model usage (one nudge). Bounded to
 * MAX_PROACTIVE_NUDGES_PER_RUN — a run that would flood the owner
 * sends the most urgent three and drops the rest. */
export function evaluateProactiveNudges(input: {
  tasks: Task[];
  modelUsage: number;
  modelCap: number;
  today?: string;
}): ProactiveNudge[] {
  const today = input.today ?? usageDateToday();
  const pending = input.tasks.filter((t) => t.status === "pending");

  const overdue = pending
    .filter((t) => {
      const due = dueDayOf(t);
      return due !== null && due < today;
    })
    .sort((a, b) => (a.due_date ?? "") < (b.due_date ?? "") ? -1 : 1);
  const dueToday = pending.filter((t) => dueDayOf(t) === today);

  const nudges: ProactiveNudge[] = [];
  for (const task of overdue) {
    const due = dueDayOf(task) ?? "unknown date";
    nudges.push({
      key: `overdue:${task.id}:${due}`,
      kind: "overdue_task",
      text: `Overdue: "${task.title}" was due ${due}.`,
    });
  }
  if (dueToday.length > 0) {
    const titles = dueToday.map((t) => `"${t.title}"`).join(", ");
    nudges.push({
      key: `due-today:${today}:${dueToday.map((t) => t.id).sort().join(",")}`,
      kind: "due_today",
      text:
        dueToday.length === 1
          ? `Due today: ${titles}.`
          : `Due today (${dueToday.length}): ${titles}.`,
    });
  }
  if (
    input.modelCap > 0 &&
    input.modelUsage >= 0 &&
    (input.modelUsage / input.modelCap) * 100 >=
      PROACTIVE_USAGE_THRESHOLD_PERCENT
  ) {
    const percent = Math.round((input.modelUsage / input.modelCap) * 100);
    nudges.push({
      key: `high-usage:${today}`,
      kind: "high_usage",
      text: `Heads up: you've used ${input.modelUsage}/${input.modelCap} model calls today (${percent}%). The limit is a display limit, so chat still works — this is just a nudge.`,
    });
  }
  return nudges.slice(0, MAX_PROACTIVE_NUDGES_PER_RUN);
}

/** Drop nudges whose key was already sent. */
export function filterUnsentNudges(
  nudges: ProactiveNudge[],
  sentKeys: ReadonlySet<string>,
): ProactiveNudge[] {
  return nudges.filter((n) => !sentKeys.has(n.key));
}
