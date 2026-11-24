"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { WaveStrip } from "./wave-strip";

export function greetingFor(hour: number): string {
  if (hour < 5) return "Good evening.";
  if (hour < 12) return "Good morning.";
  if (hour < 17) return "Good afternoon.";
  return "Good evening.";
}

// The hour comes from the browser clock (DESIGN.md 2). On the server there
// is no reliable local hour, so the greeting renders only in the browser.
const noop = () => () => {};
function useBrowserHour(): number | null {
  return useSyncExternalStore(noop, () => new Date().getHours(), () => null);
}

/** Orb states (DESIGN.md 6). The real particle-galaxy orb (M4-4) replaces
  OrbPlaceholder and keeps this exact prop — the interface is the contract. */
export type OrbState = "idle" | "listening" | "thinking" | "speaking" | "error";

export const ORB_STATE_TEXT: Record<OrbState, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  error: "Error",
};

const ORB_STATE_COLOR: Record<OrbState, string> = {
  idle: "#00e5ff",
  listening: "#00b0ff",
  thinking: "#7df9ff",
  speaking: "#00ffc8",
  error: "#f87171",
};

/**
 * Orb placeholder (M2-9a). A PLACEHOLDER, not the orb: the real
 * particle-galaxy orb lands in M4-4. It already honours the state-morphing
 * rule (DESIGN-REFERENCES.md §6) — each state is a distinct silhouette, not
 * just a colour change: idle is a calm ring, listening expands rings
 * outward, thinking spins a torus swirl, speaking pulses its nucleus with
 * radiating rings, error is a red ring. Decorative (aria-hidden); the state
 * is announced as text by OrbPanel. Under reduced motion the global CSS
 * collapses every animation to a single static frame.
 */
export function OrbPlaceholder({ state }: { state: OrbState }) {
  const color = ORB_STATE_COLOR[state];
  return (
    <div aria-hidden="true" className="relative flex size-48 items-center justify-center md:size-64">
      <svg viewBox="0 0 200 200" className="size-full">
        {state === "idle" ? (
          <>
            <circle cx="100" cy="100" r="62" fill="none" stroke={color} strokeOpacity="0.7" strokeWidth="1.5" />
            <circle cx="100" cy="100" r="40" fill="none" stroke={color} strokeOpacity="0.35" strokeWidth="1" />
            <circle cx="100" cy="100" r="10" fill={color} fillOpacity="0.9" />
          </>
        ) : state === "listening" ? (
          <>
            <circle cx="100" cy="100" r="34" fill={color} fillOpacity="0.25" />
            <circle cx="100" cy="100" r="34" fill="none" stroke={color} strokeWidth="2" />
            <circle
              cx="100"
              cy="100"
              r="52"
              fill="none"
              stroke={color}
              strokeWidth="1.5"
              className="[animation:flash-orb-listening-ring_1.8s_ease-out_infinite]"
              style={{ transformOrigin: "100px 100px" }}
            />
            <circle
              cx="100"
              cy="100"
              r="52"
              fill="none"
              stroke={color}
              strokeWidth="1.5"
              className="[animation:flash-orb-listening-ring_1.8s_ease-out_0.6s_infinite]"
              style={{ transformOrigin: "100px 100px" }}
            />
            <circle
              cx="100"
              cy="100"
              r="52"
              fill="none"
              stroke={color}
              strokeWidth="1.5"
              className="[animation:flash-orb-listening-ring_1.8s_ease-out_1.2s_infinite]"
              style={{ transformOrigin: "100px 100px" }}
            />
          </>
        ) : state === "thinking" ? (
          <g className="[animation:flash-orb-thinking-spin_6s_linear_infinite]" style={{ transformOrigin: "100px 100px" }}>
            <ellipse cx="100" cy="100" rx="70" ry="26" fill="none" stroke={color} strokeOpacity="0.7" strokeWidth="1.5" />
            <ellipse
              cx="100"
              cy="100"
              rx="70"
              ry="26"
              fill="none"
              stroke={color}
              strokeOpacity="0.5"
              strokeWidth="1.5"
              transform="rotate(60 100 100)"
            />
            <ellipse
              cx="100"
              cy="100"
              rx="70"
              ry="26"
              fill="none"
              stroke={color}
              strokeOpacity="0.5"
              strokeWidth="1.5"
              transform="rotate(120 100 100)"
            />
            <circle cx="100" cy="100" r="22" fill="none" stroke={color} strokeOpacity="0.8" strokeWidth="1.5" />
          </g>
        ) : state === "speaking" ? (
          <>
            <circle
              cx="100"
              cy="100"
              r="30"
              fill={color}
              fillOpacity="0.5"
              className="[animation:flash-orb-speaking-pulse_1.1s_ease-in-out_infinite]"
              style={{ transformOrigin: "100px 100px" }}
            />
            <circle cx="100" cy="100" r="48" fill="none" stroke={color} strokeOpacity="0.6" strokeWidth="1.5" />
            <circle cx="100" cy="100" r="66" fill="none" stroke={color} strokeOpacity="0.35" strokeWidth="1" />
            <circle cx="100" cy="100" r="80" fill="none" stroke={color} strokeOpacity="0.18" strokeWidth="1" />
          </>
        ) : (
          <>
            <circle cx="100" cy="100" r="62" fill="none" stroke={color} strokeOpacity="0.8" strokeWidth="2" />
            <path d="M100 78v44" stroke={color} strokeWidth="3" strokeLinecap="round" />
            <circle cx="100" cy="138" r="3" fill={color} />
          </>
        )}
      </svg>
      <span
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{ boxShadow: `0 0 48px 6px ${color}33` }}
      />
    </div>
  );
}

/**
 * Labels around the orb (mockup look, owner decision 2026-11-07). Each one
 * is a real part of FLASH and links to it, so none is decoration
 * (DESIGN.md 9.5). Positions are in the 760 x 540 stage; `node` is where
 * the leader line meets the orb, `elbow` where it bends.
 */
const CALLOUTS = [
  { label: "Tasks & notes", href: "/tasks", box: "left-0 top-[100px]", from: [150, 118], elbow: [196, 118], node: [244, 140] },
  { label: "Chat", href: "/chat", box: "right-0 top-[100px]", from: [610, 118], elbow: [564, 118], node: [516, 140] },
  { label: "Memory", href: "/memory", box: "left-0 top-[400px]", from: [150, 418], elbow: [196, 418], node: [246, 398] },
  { label: "Activity", href: "/activity", box: "right-0 top-[400px]", from: [610, 418], elbow: [564, 418], node: [514, 398] },
] as const;

const callout =
  "flash-frame absolute flex h-9 w-[150px] items-center justify-center rounded border text-sm text-text-primary hover:text-accent-cyan";

/**
 * Overview centre (DESIGN.md 2 and 6): the orb placeholder with labelled
 * leader lines on wide screens, the real voice state as text, the greeting
 * and a waveform strip that stays flat until M4 (no microphone yet).
 *
 * Tour support (DESIGN.md 7): while the guided tour is open,
 * `tourOrbState` overrides the idle state so the orb morphs live for each
 * step, and `onTakeTour` opens the tour. Both are optional; without them
 * the panel behaves exactly as before.
 */
export function OrbPanel({
  tourOrbState,
  onTakeTour,
}: {
  tourOrbState?: OrbState;
  onTakeTour?: () => void;
}) {
  const hour = useBrowserHour();
  const shownState: OrbState = tourOrbState ?? "idle";
  const stateText = ORB_STATE_TEXT[shownState];
  return (
    <section
      aria-labelledby="panel-flash-core"
      data-tour="orb"
      className="flash-frame relative flex h-full flex-col rounded-md border border-border bg-surface p-4"
    >
      <div className="flex min-h-11 items-center justify-between gap-2">
        <h2 id="panel-flash-core" className="panel-title">
          Central intelligence
        </h2>
        {onTakeTour ? (
          <button
            type="button"
            onClick={onTakeTour}
            className="flex min-h-9 shrink-0 items-center rounded border border-accent-cyan/30 px-3 font-display text-sm font-semibold tracking-[0.08em] text-accent-cyan uppercase transition-colors duration-150 hover:border-accent-cyan"
          >
            Take the tour
          </button>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-2">
        <div className="relative flex w-full max-w-[760px] items-center justify-center 2xl:h-[540px] 2xl:w-[760px]">
          {/* wide screens: leader lines and labels around the orb */}
          <svg
            aria-hidden="true"
            viewBox="0 0 760 540"
            className="pointer-events-none absolute inset-0 hidden size-full 2xl:block"
          >
            {CALLOUTS.map(({ label, from, elbow, node }) => (
              <g key={label} stroke="#00e5ff" strokeOpacity="0.6" fill="none">
                <polyline points={`${from.join(",")} ${elbow.join(",")} ${node.join(",")}`} strokeWidth="1" />
                <circle cx={node[0]} cy={node[1]} r="3" fill="#eaf6ff" stroke="#00e5ff" />
              </g>
            ))}
          </svg>
          <nav aria-label="FLASH parts" className="contents">
            {CALLOUTS.map(({ label, href, box }) => (
              <Link key={label} href={href} className={`${callout} ${box} hidden 2xl:flex`}>
                {label}
              </Link>
            ))}
          </nav>
          <p className="absolute top-1/2 left-8 hidden -translate-y-1/2 text-center font-display text-base leading-tight font-semibold tracking-[0.08em] text-text-secondary uppercase 2xl:block">
            FLASH
            <br />
            A.I. core
          </p>
          <p
            aria-hidden="true"
            className="absolute top-1/2 right-8 hidden -translate-y-1/2 text-center font-display text-base leading-tight font-semibold tracking-[0.08em] text-accent-cyan uppercase 2xl:block"
          >
            {stateText}
          </p>
          <OrbPlaceholder state={shownState} />
        </div>
        <p aria-live="polite" className="sr-only">
          {stateText}
        </p>
        <p
          aria-hidden="true"
          className="-mt-2 font-display text-sm font-semibold tracking-[0.08em] text-accent-cyan uppercase 2xl:hidden"
        >
          {stateText}
        </p>
        <p className="min-h-8 text-center font-display text-2xl font-medium tracking-[0.02em] text-[#d8fbff] xl:text-[1.75rem]">
          {hour === null ? "" : `${greetingFor(hour)} I'm ready when you are.`}
        </p>
        <div data-tour="wave">
          <WaveStrip />
        </div>
      </div>
    </section>
  );
}
