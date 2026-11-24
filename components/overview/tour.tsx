"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { OrbState } from "./orb";

// Cinematic guided tour (DESIGN.md 7, DESIGN-REFERENCES.md §12): the
// highlight ring glides between panels like a camera pan, the orb morphs
// live into a different state per step, a light sweep crosses the highlight,
// each caption rises in, and the dashboard re-assembles when the tour starts
// (the parent replays the panel entrances). No loading bars, no spotlight
// boxes — the ring itself carries the dimming shadow that darkens the rest
// of the screen.
//
// The tour is Overview-specific: it targets real panels by their data-tour
// id (Panel `tourId`, OrbPanel, WaveStrip). If a target is missing (narrow
// screens hide some panels, or the approvals panel does not exist yet — it
// arrives in M3-24b) the step falls back to a centred caption.
//
// Reduced motion: a calm static version — no pulsing ring, no sweep, no
// rising caption, no smooth scroll.

export type TourTarget = "orb" | "wave" | "usage" | "approvals" | "tasks" | "quick-actions" | null;

export type TourStep = {
  id: string;
  title: string;
  body: string;
  /** data-tour id of the panel to highlight, or null for a centred caption. */
  target: TourTarget;
  /** The orb morphs into this state while the step is shown. */
  orbState: OrbState;
};

/** Command Center flow: welcome, orb, voice wave, usage, approvals, tasks,
  quick actions, assembled finale. Copy states only real behaviour. */
export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to FLASH",
    body: "Your command center, assembled. Every panel here is live data — nothing on this screen is a mockup.",
    target: null,
    orbState: "idle",
  },
  {
    id: "orb",
    title: "Central intelligence",
    body: "The orb is the heart of FLASH. It listens, thinks and speaks — watch it change shape as it works.",
    target: "orb",
    orbState: "listening",
  },
  {
    id: "wave",
    title: "Your voice, honestly shown",
    body: "This strip moves only with your real microphone while FLASH listens. It never pretends to hear what it cannot.",
    target: "wave",
    orbState: "speaking",
  },
  {
    id: "usage",
    title: "Usage & Limits",
    body: "Real figures only: model calls today, and tasks done. If a figure cannot load, the panel says Unavailable — never a zero.",
    target: "usage",
    orbState: "thinking",
  },
  {
    id: "approvals",
    title: "Nothing happens without you",
    body: "When FLASH wants to change something, it waits here for your approval, with a countdown. It never acts behind your back.",
    target: "approvals",
    orbState: "idle",
  },
  {
    id: "tasks",
    title: "Tasks & notes",
    body: "What is pending, what is overdue, and what is done — straight from your lists, with due dates.",
    target: "tasks",
    orbState: "idle",
  },
  {
    id: "quick-actions",
    title: "Quick actions",
    body: "The two things you do most — a new task, a new note — one tap away.",
    target: "quick-actions",
    orbState: "idle",
  },
  {
    id: "finale",
    title: "You're set",
    body: "That's the whole command center. The tour is over — FLASH is ready when you are.",
    target: null,
    orbState: "idle",
  },
];

export function clampStep(n: number): number {
  return Math.max(0, Math.min(TOUR_STEPS.length - 1, n));
}
export function nextStep(n: number): number {
  return clampStep(n + 1);
}
export function prevStep(n: number): number {
  return clampStep(n - 1);
}

type Rect = { top: number; left: number; width: number; height: number };

// Reduced-motion users get the calm static version — no pulsing ring, no
// sweep, no rising caption, no smooth scroll. Read live from the media
// query so a mid-tour preference change is honoured.
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

export function Tour({
  open,
  step,
  onStepChange,
  onClose,
}: {
  open: boolean;
  step: number;
  onStepChange: (step: number) => void;
  onClose: () => void;
}) {
  const current = TOUR_STEPS[clampStep(step)];
  const [rect, setRect] = useState<Rect | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Bring the target into view when the step changes.
  useEffect(() => {
    if (!open || !current.target) return;
    document
      .querySelector(`[data-tour="${current.target}"]`)
      // scrollIntoView is a browser API; guard so the tour also works in
      // environments that do not implement it (jsdom in tests).
      ?.scrollIntoView?.({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
  }, [open, current.target, reducedMotion]);

  // Measure the target (and re-measure on resize/scroll, so the ring tracks it).
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      if (!current.target) {
        setRect(null);
        return;
      }
      const el = document.querySelector(`[data-tour="${current.target}"]`);
      if (!el) {
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, current.target]);

  // Esc closes; focus the caption heading on every step so screen readers follow.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    headingRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, current.id, onClose]);

  if (!open) return null;
  const last = step >= TOUR_STEPS.length - 1;
  // Caption below the target when it fits, above it when it does not, centred otherwise.
  const captionStyle: React.CSSProperties =
    rect && typeof window !== "undefined" && rect.top + rect.height + 200 < window.innerHeight
      ? {
          top: rect.top + rect.height + 20,
          left: Math.max(12, Math.min(rect.left, window.innerWidth - 392)),
          width: "min(92vw, 380px)",
        }
      : rect && typeof window !== "undefined" && rect.top > 220
        ? {
            top: rect.top - 200,
            left: Math.max(12, Math.min(rect.left, window.innerWidth - 392)),
            width: "min(92vw, 380px)",
          }
        : { top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: "min(92vw, 380px)" };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="tour-title" className="fixed inset-0 z-50">
      {rect ? (
        <div
          aria-hidden="true"
          className={
            reducedMotion
              ? "absolute rounded-md border-2 border-accent-cyan"
              : "absolute rounded-md border-2 border-accent-cyan [animation:flash-tour-ring_2s_ease-in-out_infinite] [transition:top_0.6s_var(--ease-standard),left_0.6s_var(--ease-standard),width_0.6s_var(--ease-standard),height_0.6s_var(--ease-standard)]"
          }
          style={{ top: rect.top - 8, left: rect.left - 8, width: rect.width + 16, height: rect.height + 16 }}
        >
          {!reducedMotion ? (
            <div aria-hidden="true" className="absolute inset-0 overflow-hidden rounded-md">
              <div className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-accent-cyan/25 to-transparent [animation:flash-tour-sweep_2.4s_ease-in-out_infinite]" />
            </div>
          ) : null}
        </div>
      ) : (
        <div aria-hidden="true" className="absolute inset-0 bg-background/80" />
      )}
      <div
        key={current.id}
        className={
          reducedMotion
            ? "flash-frame absolute rounded-md border bg-surface p-5"
            : "flash-frame absolute rounded-md border bg-surface p-5 [animation:flash-tour-caption-in_0.5s_var(--ease-out-expo)_both]"
        }
        style={captionStyle}
      >
        <p className="font-mono text-xs tracking-[0.08em] text-text-muted uppercase">
          Step {clampStep(step) + 1} of {TOUR_STEPS.length}
        </p>
        <h3
          id="tour-title"
          ref={headingRef}
          tabIndex={-1}
          className="mt-1 font-display text-xl font-semibold tracking-[0.03em] text-text-primary uppercase outline-none"
        >
          {current.title}
        </h3>
        <p className="mt-2 text-base leading-snug text-text-secondary">{current.body}</p>
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={() => onStepChange(prevStep(step))}
            disabled={step <= 0}
            className="flex min-h-11 items-center rounded-md border border-border-strong px-4 text-sm text-text-primary transition-colors duration-150 hover:bg-surface-raised disabled:opacity-40"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => (last ? onClose() : onStepChange(nextStep(step)))}
            className="flex min-h-11 flex-1 items-center justify-center rounded-md bg-accent-cyan px-4 font-medium text-on-accent transition-colors duration-150 hover:bg-accent-deep"
          >
            {last ? "Finish" : "Next"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-11 items-center rounded-md px-3 text-sm text-text-secondary underline-offset-4 hover:text-text-primary hover:underline"
          >
            Skip tour
          </button>
        </div>
      </div>
    </div>
  );
}
