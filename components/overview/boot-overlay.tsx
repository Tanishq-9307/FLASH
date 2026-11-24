"use client";

import { useEffect, useRef, useState } from "react";
import { greetingFor } from "./orb";

// Cinematic boot overlay (DESIGN.md 7, DESIGN-REFERENCES.md §8): a spinning
// wireframe globe, light streaks crossing the screen, the wordmark rising in
// and a greeting — then the whole overlay fades away. It plays once per
// browser session, never blocks interaction (pointer-events-none), and never
// shows a percentage counter or a progress bar — anywhere.
//
// Skipped entirely under reduced motion and on repeat visits within the
// session. If session storage is unavailable the boot does not play at all,
// rather than risking a replay loop.
//
// The decision runs in a requestAnimationFrame callback after mount (not in
// the effect body, and not during render): the first client render matches
// the server render (nothing), so there is no hydration mismatch.
const BOOT_KEY = "flash-boot-played";
const BOOT_MS = 3000;

export function BootOverlay() {
  const [show, setShow] = useState(false);
  // The greeting hour is a pure read of the browser clock; the overlay only
  // renders once show is true, which happens client-side after mount.
  const [hour] = useState<number | null>(() =>
    typeof window === "undefined" ? null : new Date().getHours(),
  );
  const hideRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        if (sessionStorage.getItem(BOOT_KEY) === "1") return;
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        sessionStorage.setItem(BOOT_KEY, "1");
      } catch {
        return;
      }
      setShow(true);
      hideRef.current = setTimeout(() => setShow(false), BOOT_MS);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (hideRef.current !== undefined) clearTimeout(hideRef.current);
    };
  }, []);

  if (!show) return null;
  return (
    <div
      aria-hidden="true"
      role="presentation"
      className="pointer-events-none fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 overflow-hidden bg-background [animation:flash-boot-fade_3s_var(--ease-standard)_both]"
      onAnimationEnd={(e) => {
        if (e.animationName === "flash-boot-fade") setShow(false);
      }}
    >
      {/* light streaks crossing the screen */}
      <div className="absolute top-[38%] left-0 h-px w-full bg-gradient-to-r from-transparent via-accent-cyan/70 to-transparent [animation:flash-boot-streak_1.4s_ease-in-out_0.2s_both]" />
      <div className="absolute top-[62%] left-0 h-px w-full bg-gradient-to-r from-transparent via-accent-deep/60 to-transparent [animation:flash-boot-streak_1.4s_ease-in-out_0.9s_both]" />
      {/* spinning wireframe globe with a particle burst */}
      <div className="relative size-40">
        <svg viewBox="0 0 160 160" className="size-full [animation:flash-boot-globe-spin_2.2s_linear_infinite]">
          <circle cx="80" cy="80" r="70" fill="none" stroke="#00e5ff" strokeOpacity="0.7" strokeWidth="1.5" />
          <ellipse cx="80" cy="80" rx="70" ry="26" fill="none" stroke="#00e5ff" strokeOpacity="0.45" />
          <ellipse cx="80" cy="80" rx="70" ry="26" fill="none" stroke="#00b0ff" strokeOpacity="0.45" transform="rotate(60 80 80)" />
          <ellipse cx="80" cy="80" rx="70" ry="26" fill="none" stroke="#00b0ff" strokeOpacity="0.45" transform="rotate(120 80 80)" />
          <circle cx="80" cy="80" r="34" fill="none" stroke="#7df9ff" strokeOpacity="0.6" />
          <circle cx="80" cy="80" r="6" fill="#eaf6ff" />
        </svg>
        <div className="absolute top-1/2 left-1/2 size-40 rounded-full border border-accent-cyan/50 [animation:flash-boot-burst_1.2s_ease-out_0.6s_both]" />
      </div>
      {/* wordmark, then the greeting */}
      <p className="font-display text-4xl font-bold tracking-[0.38em] text-text-primary [text-shadow:0_0_18px_rgb(0_229_255/0.6)] [animation:flash-boot-rise_0.8s_var(--ease-out-expo)_0.3s_both]">
        FLASH
      </p>
      <p className="font-display text-sm font-semibold tracking-[0.38em] text-accent-cyan uppercase [animation:flash-boot-rise_0.8s_var(--ease-out-expo)_1.6s_both]">
        {hour === null ? "Powering on" : `${greetingFor(hour).replace(/\.$/, "")}, Sir.`}
      </p>
    </div>
  );
}
