"use client";

import { useEffect, useState } from "react";
import { usagePercent } from "@/lib/usage";
import {
  formatBytes,
  formatClockTime,
  formatLatency,
  readChatLatency,
  readJsHeap,
  type ChatLatencySample,
  type HealthLatency,
  type JsHeapReading,
} from "@/lib/telemetry";
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
      /** The provider that answered the most recent model call
       * ("groq" normally, "openrouter" after a failover answered);
       * absent when the health body predates the provider chip. */
      provider?: "groq" | "openrouter";
    };

export type TaskTally = { done: number; total: number } | null;

/** App telemetry (owner-directed addition, 2026-11-24; DESIGN.md §9):
 * every field is a real measurement or null. `chat` is the last timed
 * chat reply (send → first token → completion), `health` is the timed
 * /api/health fetch, `heap` is the browser-reported JS heap when this
 * browser provides it. Null means "never measured" — the panel says so
 * instead of showing a number. There is deliberately no laptop
 * hardware here: a web app cannot read it. */
export type TelemetryState = {
  chat: ChatLatencySample | null;
  health: HealthLatency | null;
  heap: JsHeapReading | null;
};

const EMPTY_TELEMETRY: TelemetryState = { chat: null, health: null, heap: null };

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
 * REACHED" state any more. Telemetry (2026-11-24) is app telemetry
 * only: the timed health fetch, the last timed chat reply, and the
 * browser-reported JS heap when the browser provides it — measured
 * values or "No requests yet" / "Unavailable", never invented figures.
 */
export function UsagePanelView({
  state,
  tasks = null,
  openApprovals,
  memoryEnabled,
  telemetry = EMPTY_TELEMETRY,
  showUsageMeter,
}: {
  state: UsageState;
  tasks?: TaskTally;
  /** Pending approvals, or null when the load failed. */
  openApprovals?: number | null;
  /** The memory switch, or null when the load failed. */
  memoryEnabled?: boolean | null;
  /** Measured app telemetry; absent means nothing has been measured yet. */
  telemetry?: TelemetryState;
  /** Phase 2 (live configuration): the usage-meter display setting.
   * False hides the gauges; null (load failed) shows them — a failed
   * settings read must not hide real data. */
  showUsageMeter?: boolean | null;
}) {
  // The meter is off: say so and point at Settings, instead of
  // showing gauges the owner asked to hide — or a blank space.
  if (showUsageMeter === false) {
    return (
      <Panel title="Usage & Limits" tourId="usage">
        <p className="text-sm text-text-secondary">
          Usage meter is off. Turn it on in{" "}
          <a href="/settings" className="text-accent-cyan underline">
            Settings
          </a>{" "}
          to see it again.
        </p>
      </Panel>
    );
  }
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
            {state.kind === "ok" && state.provider !== undefined ? (
              <p className="mt-2 text-sm text-text-secondary">
                Provider:{" "}
                <span className="text-text-primary">
                  {state.provider === "openrouter"
                    ? "OpenRouter (fallback — Groq failed)"
                    : "Groq"}
                </span>
              </p>
            ) : null}
          </div>
          <div className="mt-4 border-t border-border pt-3">
            <p className="font-display text-base font-semibold tracking-[0.06em] text-text-primary uppercase">
              Telemetry
            </p>
            <p className="mt-1 text-sm text-text-secondary">
              Last chat reply:{" "}
              {telemetry.chat &&
              formatLatency(telemetry.chat.firstTokenMs) !== null &&
              formatLatency(telemetry.chat.totalMs) !== null ? (
                <span className="text-text-primary">
                  first token {formatLatency(telemetry.chat.firstTokenMs)} · completed{" "}
                  {formatLatency(telemetry.chat.totalMs)}
                  {formatClockTime(telemetry.chat.at) !== null
                    ? ` · ${formatClockTime(telemetry.chat.at)}`
                    : ""}
                </span>
              ) : (
                <span className="text-text-primary">No requests yet</span>
              )}
            </p>
            <p className="mt-2 text-sm text-text-secondary">
              Health check:{" "}
              {telemetry.health && formatLatency(telemetry.health.ms) !== null ? (
                <span className="text-text-primary">
                  {formatLatency(telemetry.health.ms)}
                  {formatClockTime(telemetry.health.at) !== null
                    ? ` · ${formatClockTime(telemetry.health.at)}`
                    : ""}
                </span>
              ) : (
                <span className="text-text-primary">Unavailable</span>
              )}
            </p>
            {telemetry.heap &&
            formatBytes(telemetry.heap.usedBytes) !== null &&
            formatBytes(telemetry.heap.totalBytes) !== null ? (
              <p className="mt-2 text-sm text-text-secondary">
                JS heap (browser-reported):{" "}
                <span className="text-text-primary">
                  {formatBytes(telemetry.heap.usedBytes)} used of{" "}
                  {formatBytes(telemetry.heap.totalBytes)}
                </span>
              </p>
            ) : null}
            <p className="mt-2 text-xs text-text-muted">
              App telemetry only — a web app cannot read this device&apos;s hardware.
            </p>
          </div>
        </>
      )}
    </Panel>
  );
}

/** Reads the real figures from /api/health (no model call, no quota). */
export function usageFromHealth(ok: boolean, body: unknown): UsageState {
  const b = body as { usage?: unknown; cap?: unknown; searchUsage?: unknown; searchCap?: unknown; provider?: unknown } | null;
  if (!ok || typeof b?.usage !== "number" || typeof b?.cap !== "number") return { kind: "unavailable" };
  return {
    kind: "ok",
    usage: b.usage,
    cap: b.cap,
    ...(typeof b.searchUsage === "number" && typeof b.searchCap === "number"
      ? { searchUsage: b.searchUsage, searchCap: b.searchCap }
      : {}),
    ...(b.provider === "groq" || b.provider === "openrouter"
      ? { provider: b.provider }
      : {}),
  };
}

export function UsagePanel({
  tasks = null,
  openApprovals,
  memoryEnabled,
  showUsageMeter,
}: {
  tasks?: TaskTally;
  openApprovals?: number | null;
  memoryEnabled?: boolean | null;
  /** Phase 2 (live configuration): the usage-meter display setting. */
  showUsageMeter?: boolean | null;
}) {
  const [state, setState] = useState<UsageState>({ kind: "loading" });
  // Browser-only readings, taken once at mount from the state
  // initializer: the last measured chat reply (kept in localStorage by
  // Chat) and the JS heap, when this browser reports one (Chromium
  // only — otherwise it stays null and the panel leaves the line out
  // entirely). The initializer runs before the health fetch resolves,
  // while the panel still shows "Loading…", so these values never
  // reach the server-rendered HTML.
  const [telemetry, setTelemetry] = useState<TelemetryState>(() => ({
    chat: readChatLatency(),
    health: null,
    heap: readJsHeap(),
  }));
  useEffect(() => {
    let cancelled = false;
    // The health fetch is timed with the same clock the chat tracker
    // uses, so the "Health check" line is a real measured duration.
    const startedAt = performance.now();
    fetch("/api/health", { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!cancelled) {
          setTelemetry((prev) => ({
            ...prev,
            health: { ms: performance.now() - startedAt, at: new Date().toISOString() },
          }));
        }
        return usageFromHealth(res.ok, body);
      })
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
      telemetry={telemetry}
      showUsageMeter={showUsageMeter}
    />
  );
}
