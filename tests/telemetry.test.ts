// @vitest-environment jsdom
// App telemetry unit tests (2026-11-24): formatting helpers, the JS-heap
// reader's present/absent paths, the chat-latency store, and the
// send → first-token → finish tracker. Every number here is a fixture
// for the helpers — no mock data ships in the product.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_LATENCY_KEY,
  createChatLatencyTracker,
  formatBytes,
  formatClockTime,
  formatLatency,
  readChatLatency,
  readJsHeap,
  recordChatLatency,
  type ChatLatencySample,
} from "@/lib/telemetry";

const sample: ChatLatencySample = {
  firstTokenMs: 1200,
  totalMs: 4500,
  at: "2026-11-24T14:45:00.000Z",
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("formatLatency", () => {
  it("shows milliseconds below a second and seconds at and above it", () => {
    expect(formatLatency(0)).toBe("0 ms");
    expect(formatLatency(42)).toBe("42 ms");
    expect(formatLatency(999)).toBe("999 ms");
    expect(formatLatency(1000)).toBe("1.0 s");
    expect(formatLatency(1200)).toBe("1.2 s");
    expect(formatLatency(4500)).toBe("4.5 s");
  });

  it("returns null for a value that is not a real measurement", () => {
    expect(formatLatency(NaN)).toBeNull();
    expect(formatLatency(Infinity)).toBeNull();
    expect(formatLatency(-1)).toBeNull();
  });
});

describe("formatClockTime", () => {
  it("renders a local HH:MM time for a valid timestamp", () => {
    expect(formatClockTime("2026-11-24T14:45:00.000Z")).toMatch(/^\d{2}:\d{2}$/);
  });

  it("returns null for an unparseable timestamp", () => {
    expect(formatClockTime("not a date")).toBeNull();
    expect(formatClockTime("")).toBeNull();
  });
});

describe("formatBytes", () => {
  it("renders megabytes with one decimal", () => {
    expect(formatBytes(48 * 1024 * 1024)).toBe("48.0 MB");
    expect(formatBytes(0)).toBe("0.0 MB");
  });

  it("returns null for a value that is not a real measurement", () => {
    expect(formatBytes(NaN)).toBeNull();
    expect(formatBytes(-1)).toBeNull();
  });
});

describe("readJsHeap", () => {
  it("returns null when the browser does not provide performance.memory", () => {
    // jsdom has no performance.memory: the honest absent path.
    expect(readJsHeap()).toBeNull();
  });

  it("reads the heap when the browser provides it", () => {
    Object.defineProperty(performance, "memory", {
      configurable: true,
      value: {
        usedJSHeapSize: 48 * 1024 * 1024,
        totalJSHeapSize: 96 * 1024 * 1024,
        jsHeapSizeLimit: 2 * 1024 * 1024 * 1024,
      },
    });
    expect(readJsHeap()).toEqual({
      usedBytes: 48 * 1024 * 1024,
      totalBytes: 96 * 1024 * 1024,
      limitBytes: 2 * 1024 * 1024 * 1024,
    });
    // @ts-expect-error removing the stub for the next test
    delete performance.memory;
  });

  it("returns null when the heap object is incomplete or non-numeric", () => {
    Object.defineProperty(performance, "memory", {
      configurable: true,
      value: { usedJSHeapSize: 1, totalJSHeapSize: "lots" },
    });
    expect(readJsHeap()).toBeNull();
    // @ts-expect-error removing the stub for the next test
    delete performance.memory;
  });
});

describe("recordChatLatency / readChatLatency", () => {
  it("round-trips a real sample", () => {
    recordChatLatency(sample);
    expect(readChatLatency()).toEqual(sample);
    expect(window.localStorage.getItem(CHAT_LATENCY_KEY)).toContain("1200");
  });

  it("returns null when nothing was ever recorded", () => {
    expect(readChatLatency()).toBeNull();
  });

  it("treats a corrupt stored value as no measurement", () => {
    window.localStorage.setItem(CHAT_LATENCY_KEY, "{not json");
    expect(readChatLatency()).toBeNull();
  });

  it("treats a wrong-shaped stored value as no measurement", () => {
    window.localStorage.setItem(
      CHAT_LATENCY_KEY,
      JSON.stringify({ firstTokenMs: -5, totalMs: 100, at: "2026-11-24T14:45:00.000Z" }),
    );
    expect(readChatLatency()).toBeNull();
    window.localStorage.setItem(
      CHAT_LATENCY_KEY,
      JSON.stringify({ firstTokenMs: 100, totalMs: 200, at: "yesterday" }),
    );
    expect(readChatLatency()).toBeNull();
  });
});

describe("createChatLatencyTracker", () => {
  it("measures send → first token → completion with an injected clock", () => {
    let t = 1000;
    const tracker = createChatLatencyTracker(() => t);
    tracker.onSend();
    t = 2200;
    tracker.onFirstToken();
    t = 5500;
    const out = tracker.onFinish("2026-11-24T14:45:00.000Z");
    expect(out).toEqual({ firstTokenMs: 1200, totalMs: 4500, at: "2026-11-24T14:45:00.000Z" });
    // The tracker resets: a second finish with no send in flight is null.
    expect(tracker.onFinish("2026-11-24T14:46:00.000Z")).toBeNull();
  });

  it("keeps the first token time when onFirstToken is called twice", () => {
    let t = 1000;
    const tracker = createChatLatencyTracker(() => t);
    tracker.onSend();
    t = 1500;
    tracker.onFirstToken();
    t = 3000;
    tracker.onFirstToken();
    t = 4000;
    expect(tracker.onFinish("2026-11-24T14:45:00.000Z")?.firstTokenMs).toBe(500);
  });

  it("records nothing when the reply never streams a token", () => {
    const tracker = createChatLatencyTracker(() => 1000);
    tracker.onSend();
    expect(tracker.onFinish("2026-11-24T14:45:00.000Z")).toBeNull();
  });

  it("records nothing with no send in flight", () => {
    const tracker = createChatLatencyTracker(() => 1000);
    expect(tracker.onFinish("2026-11-24T14:45:00.000Z")).toBeNull();
  });

  it("a stopped reply records nothing, and the next reply still measures", () => {
    let t = 1000;
    const tracker = createChatLatencyTracker(() => t);
    tracker.onSend();
    t = 1500;
    tracker.onFirstToken();
    tracker.onStop();
    t = 2000;
    expect(tracker.onFinish("2026-11-24T14:45:00.000Z")).toBeNull();
    t = 3000;
    tracker.onSend();
    t = 3200;
    tracker.onFirstToken();
    t = 5000;
    expect(tracker.onFinish("2026-11-24T14:46:00.000Z")).toEqual({
      firstTokenMs: 200,
      totalMs: 2000,
      at: "2026-11-24T14:46:00.000Z",
    });
  });

  it("an error clears the in-flight send", () => {
    let t = 1000;
    const tracker = createChatLatencyTracker(() => t);
    tracker.onSend();
    t = 1500;
    tracker.onFirstToken();
    tracker.onError();
    t = 2000;
    expect(tracker.onFinish("2026-11-24T14:45:00.000Z")).toBeNull();
  });
});
