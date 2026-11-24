// App telemetry (owner-directed addition, 2026-11-24): FLASH is a web
// app, so it cannot read the laptop's hardware — no CPU, RAM, storage or
// network figures exist here and none are shown. Everything in this file
// is measured in the browser or it is not shown at all (DESIGN.md §9):
// chat reply latency is timed client-side from send to first streamed
// token and to completion, the health-check fetch is timed around the
// real /api/health call, and the JS heap comes from performance.memory
// when the browser provides it (Chromium only). A value that has never
// been measured renders as "No requests yet" / "Unavailable", never as
// a placeholder number.

export type ChatLatencySample = {
  /** Milliseconds from send to the first streamed token. */
  firstTokenMs: number;
  /** Milliseconds from send to the completed reply. */
  totalMs: number;
  /** ISO timestamp of when the reply completed. */
  at: string;
};

export type HealthLatency = {
  /** Milliseconds the /api/health fetch took. */
  ms: number;
  /** ISO timestamp of when the fetch completed. */
  at: string;
};

export type JsHeapReading = {
  usedBytes: number;
  totalBytes: number;
  limitBytes: number;
};

/** Where the last measured chat reply is kept, so the Overview can show
 * it after navigating away from Chat. One sample only — the most recent
 * reply — and only ever a real measurement. */
export const CHAT_LATENCY_KEY = "flash:last-chat-latency";

/** "843 ms" below a second, "1.2 s" at and above it. Null for a value
 * that is not a real non-negative measurement. */
export function formatLatency(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Local "20:14" for a measurement timestamp, or null when unparseable. */
export function formatClockTime(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Bytes as "48.0 MB", or null for a value that is not a real
 * non-negative measurement. */
export function formatBytes(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isChatLatencySample(value: unknown): value is ChatLatencySample {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.firstTokenMs === "number" &&
    Number.isFinite(v.firstTokenMs) &&
    v.firstTokenMs >= 0 &&
    typeof v.totalMs === "number" &&
    Number.isFinite(v.totalMs) &&
    v.totalMs >= 0 &&
    typeof v.at === "string" &&
    !Number.isNaN(new Date(v.at).getTime())
  );
}

/** Best-effort store: when storage is unavailable the sample is simply
 * not kept for the Overview — telemetry never throws into chat. */
export function recordChatLatency(sample: ChatLatencySample): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(CHAT_LATENCY_KEY, JSON.stringify(sample));
  } catch {
    // Storage full, blocked, or unavailable: no sample is kept.
  }
}

/** The last measured chat reply, or null when none was ever recorded or
 * the stored value is corrupt — a bad row is treated as no measurement. */
export function readChatLatency(): ChatLatencySample | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(CHAT_LATENCY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isChatLatencySample(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

type PerformanceWithMemory = Performance & {
  memory?: {
    usedJSHeapSize?: unknown;
    totalJSHeapSize?: unknown;
    jsHeapSizeLimit?: unknown;
  };
};

/** The browser-reported JS heap (Chromium's performance.memory), or null
 * when this browser does not provide it — the caller then leaves the
 * reading out entirely instead of showing a substitute. */
export function readJsHeap(): JsHeapReading | null {
  if (typeof performance === "undefined") return null;
  const memory = (performance as PerformanceWithMemory).memory;
  if (!memory) return null;
  const { usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit } = memory;
  if (
    typeof usedJSHeapSize !== "number" ||
    typeof totalJSHeapSize !== "number" ||
    typeof jsHeapSizeLimit !== "number"
  ) {
    return null;
  }
  return {
    usedBytes: usedJSHeapSize,
    totalBytes: totalJSHeapSize,
    limitBytes: jsHeapSizeLimit,
  };
}

/** Client-side timing for one chat reply, driven by the chat hook's
 * status: onSend when the message goes out, onFirstToken when the
 * stream starts, onFinish when it completes. A stopped reply, an error,
 * or a finish with no first token produces no sample — a partial or
 * failed reply is not a completed reply, so it is never reported as
 * one. The clock is injectable so tests can drive exact timings. */
export function createChatLatencyTracker(
  now: () => number = () => performance.now(),
) {
  let sentAt: number | null = null;
  let firstTokenAt: number | null = null;
  let stopped = false;

  function reset() {
    sentAt = null;
    firstTokenAt = null;
    stopped = false;
  }

  return {
    onSend() {
      sentAt = now();
      firstTokenAt = null;
      stopped = false;
    },
    onFirstToken() {
      if (sentAt !== null && firstTokenAt === null) firstTokenAt = now();
    },
    onStop() {
      stopped = true;
    },
    onError() {
      reset();
    },
    onFinish(at: string): ChatLatencySample | null {
      if (sentAt === null || firstTokenAt === null || stopped) {
        reset();
        return null;
      }
      const sample: ChatLatencySample = {
        firstTokenMs: firstTokenAt - sentAt,
        totalMs: now() - sentAt,
        at,
      };
      reset();
      return sample;
    },
  };
}
