"use client";

import { useEffect, useState } from "react";
import { Panel, Unavailable } from "./panel";
import { RingGauge, RingGaugeUnavailable } from "./ring-gauge";

export type UsageState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "ok"; usage: number; cap: number };

export type TaskTally = { done: number; total: number } | null;

/**
 * Usage & Limits (DESIGN.md 2 and 5.7), in the mockup's ring-gauge style.
 * Every gauge is a real figure: model calls today from /api/health, and
 * tasks done from the task list. The mockup's CPU, RAM and network gauges
 * are not shown because FLASH has no such readings (9.1). Open approvals
 * and memory state join this panel in M3-24b, not here.
 */
export function UsagePanelView({ state, tasks = null }: { state: UsageState; tasks?: TaskTally }) {
  return (
    <Panel title="Usage & Limits" tourId="usage">
      {state.kind === "loading" ? (
        <p role="status" className="text-sm text-text-secondary">
          Loading…
        </p>
      ) : state.kind === "unavailable" ? (
        <Unavailable what="Today's usage" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <RingGauge value={state.usage} max={state.cap} label="AI calls" />
            {tasks ? (
              <RingGauge value={tasks.done} max={tasks.total} label="Tasks done" />
            ) : (
              <RingGaugeUnavailable label="Tasks done" />
            )}
          </div>
          <div className="mt-4 border-t border-border pt-3">
            <p className="font-display text-base font-semibold tracking-[0.06em] text-text-primary uppercase">
              Daily limits
            </p>
            <p className="mt-1 flex items-center gap-2 text-lg">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
                className="size-6 text-accent-cyan"
              >
                <path d="M3 12h4l3-8 4 16 3-8h4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>
                Resets 00:00 IST <span className="text-text-muted">{"//"}</span>{" "}
                <span className={state.usage >= state.cap ? "text-warning" : "text-accent-cyan"}>
                  {state.usage >= state.cap ? "LIMIT REACHED" : "WITHIN LIMITS"}
                </span>
              </span>
            </p>
          </div>
        </>
      )}
    </Panel>
  );
}

/** Reads the real figures from /api/health (no model call, no quota). */
export function usageFromHealth(ok: boolean, body: unknown): UsageState {
  const b = body as { usage?: unknown; cap?: unknown } | null;
  if (!ok || typeof b?.usage !== "number" || typeof b?.cap !== "number") return { kind: "unavailable" };
  return { kind: "ok", usage: b.usage, cap: b.cap };
}

export function UsagePanel({ tasks = null }: { tasks?: TaskTally }) {
  const [state, setState] = useState<UsageState>({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health", { cache: "no-store" })
      .then(async (res) => usageFromHealth(res.ok, await res.json().catch(() => null)))
      .catch((): UsageState => ({ kind: "unavailable" }))
      .then((next) => {
        if (!cancelled) setState(next);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return <UsagePanelView state={state} tasks={tasks} />;
}
