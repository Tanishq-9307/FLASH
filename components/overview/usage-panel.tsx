"use client";

import { useEffect, useState } from "react";
import { usagePercent } from "@/lib/usage";
import { Panel, Unavailable } from "./panel";
import { RingGauge, RingGaugeUnavailable } from "./ring-gauge";

export type UsageState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | {
      kind: "ok";
      usage: number;
      cap: number;
      /** This calendar month's searches; absent when the health body predates the meter. */
      searchUsage?: number;
      /** The monthly search limit; absent when the health body predates the meter. */
      searchCap?: number;
    };

export type TaskTally = { done: number; total: number } | null;

/**
 * Usage & Limits (DESIGN.md 2 and 5.7), in the mockup's ring-gauge style.
 * Every gauge is a real figure: model calls today from /api/health, and
 * tasks done from the task list. The mockup's CPU, RAM and network gauges
 * are not shown because FLASH has no such readings (9.1). Open approvals
 * and memory state join here in M3-24b: the gauge counts pending
 * approvals (0 or 1 — a second proposal is refused while one is open),
 * and memory is the settings switch. An undefined prop means the caller
 * did not supply that figure (older tests); null means the load failed
 * and the gauge says Unavailable, never zero.
 *
 * Meters (owner decision 2026-11-24): the limits are display limits
 * only — chat and search are never blocked by them. The panel shows
 * today's model-call usage as a percentage of the configured daily
 * limit, and this month's search usage as a percentage of the monthly
 * limit (Tavily credits, 1 per basic search). There is no "LIMIT
 * REACHED" state any more.
 */
export function UsagePanelView({
  state,
  tasks = null,
  openApprovals,
  memoryEnabled,
}: {
  state: UsageState;
  tasks?: TaskTally;
  /** Pending approvals, or null when the load failed. */
  openApprovals?: number | null;
  /** The memory switch, or null when the load failed. */
  memoryEnabled?: boolean | null;
}) {
  const modelPercent =
    state.kind === "ok" ? usagePercent(state.usage, state.cap) : null;
  const searchPercent =
    state.kind === "ok" &&
    typeof state.searchUsage === "number" &&
    typeof state.searchCap === "number"
      ? usagePercent(state.searchUsage, state.searchCap)
      : null;
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
            {openApprovals === undefined ? null : openApprovals === null ? (
              <RingGaugeUnavailable label="Open approvals" />
            ) : (
              <RingGauge value={openApprovals} max={1} label="Open approvals" />
            )}
          </div>
          {memoryEnabled === undefined ? null : (
            <p className="mt-3 text-sm text-text-secondary">
              Memory:{" "}
              <span className="text-text-primary">
                {memoryEnabled === null
                  ? "Unavailable"
                  : memoryEnabled
                    ? "On — approved facts are remembered"
                    : "Off — nothing is remembered or injected"}
              </span>
            </p>
          )}
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
                <span className="text-accent-cyan">
                  {modelPercent === null ? "Limit not set" : `${modelPercent}% used`}
                </span>
              </span>
            </p>
            {searchPercent !== null && state.kind === "ok" ? (
              <p className="mt-2 text-sm text-text-secondary">
                Search this month:{" "}
                <span className="text-text-primary">
                  {searchPercent}% used ({state.searchUsage} of {state.searchCap} credits)
                </span>
              </p>
            ) : null}
          </div>
        </>
      )}
    </Panel>
  );
}

/** Reads the real figures from /api/health (no model call, no quota). */
export function usageFromHealth(ok: boolean, body: unknown): UsageState {
  const b = body as { usage?: unknown; cap?: unknown; searchUsage?: unknown; searchCap?: unknown } | null;
  if (!ok || typeof b?.usage !== "number" || typeof b?.cap !== "number") return { kind: "unavailable" };
  return {
    kind: "ok",
    usage: b.usage,
    cap: b.cap,
    ...(typeof b.searchUsage === "number" && typeof b.searchCap === "number"
      ? { searchUsage: b.searchUsage, searchCap: b.searchCap }
      : {}),
  };
}

export function UsagePanel({
  tasks = null,
  openApprovals,
  memoryEnabled,
}: {
  tasks?: TaskTally;
  openApprovals?: number | null;
  memoryEnabled?: boolean | null;
}) {
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
  return (
    <UsagePanelView
      state={state}
      tasks={tasks}
      openApprovals={openApprovals}
      memoryEnabled={memoryEnabled}
    />
  );
}
