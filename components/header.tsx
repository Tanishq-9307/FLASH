// Header (M1-9, DESIGN.md §5.3/§2): wordmark, truthful status chip, quick-ask
// bar (M1-10b), clock, account menu.
//
// The wordmark is the plain-text placeholder from DESIGN.md §11 (already
// recorded there: "FLASH" in JetBrains Mono until an owned SVG exists).
// The chip polls /api/health every 30 s and shows Online with today's
// model-call usage as a percentage of the configured daily limit
// ("Online · 5% used"), or Offline (the check failed or the session is
// gone) — each with an icon and a text label, never colour alone
// (DESIGN.md §8). There is no "Degraded" state yet: /api/health reports
// no signal for it, so it is deferred, not invented. There is no "Limit
// reached" state any more (owner decision 2026-11-24): the daily limit
// is a display limit only, chat is never blocked by it.
// The clock is the browser's real local time, rendered only after mount
// (server and browser clocks differ, so rendering it during SSR would
// hydrate-mismatch). The header renders nothing on /login.
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "@/app/login/actions";
import { usagePercent } from "@/lib/usage";
import { QuickAskBar } from "./quick-ask";

export type HealthStatus = "checking" | "online" | "offline";

const CHIP: Record<
  HealthStatus,
  { label: string; icon: React.ReactElement; className: string }
> = {
  checking: {
    label: "Checking…",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
        <circle cx="12" cy="12" r="8" strokeDasharray="4 4" />
      </svg>
    ),
    className: "text-text-muted",
  },
  online: {
    label: "Online",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12.5 2.5 2.5L16 9.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    className: "text-success",
  },
  offline: {
    label: "Offline",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="m9 9 6 6M15 9l-6 6" strokeLinecap="round" />
      </svg>
    ),
    className: "text-danger",
  },
};

/** The top-bar status chip. When online and the health check reported
 * real usage figures, the chip also shows today's model-call usage as
 * a percentage of the configured daily limit. */
export function StatusChip({
  status,
  percent,
}: {
  status: HealthStatus;
  /** Today's model-call usage as a percentage, or null when unknown. */
  percent?: number | null;
}) {
  const chip = CHIP[status];
  return (
    <span
      role="status"
      className={`inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-surface-raised px-3 text-sm ${chip.className}`}
    >
      {chip.icon}
      <span className="text-text-primary">{chip.label}</span>
      {status === "online" && percent !== undefined && percent !== null ? (
        <span className="text-text-secondary">· {percent}% used</span>
      ) : null}
    </span>
  );
}

function formatClock(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default function Header({ userEmail }: { userEmail: string | null }) {
  const pathname = usePathname();
  const [status, setStatus] = useState<HealthStatus>("checking");
  const [percent, setPercent] = useState<number | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    // The clock renders only after mount: the server and browser clocks
    // differ, so rendering it during SSR would hydrate-mismatch. The first
    // tick is scheduled (not a synchronous setState in the effect body).
    const first = setTimeout(() => setNow(new Date()), 0);
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    // No polling on /login: the header renders nothing there.
    if (pathname === "/login") return;
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        if (cancelled) return;
        if (!res.ok) {
          setStatus("offline");
          setPercent(null);
          return;
        }
        const data = (await res.json()) as { status?: string; usage?: unknown; cap?: unknown };
        setStatus("online");
        setPercent(
          typeof data.usage === "number" && typeof data.cap === "number"
            ? usagePercent(data.usage, data.cap)
            : null,
        );
      } catch {
        if (!cancelled) {
          setStatus("offline");
          setPercent(null);
        }
      }
    }
    void check();
    const timer = setInterval(() => void check(), 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pathname]);

  if (pathname === "/login") return null;

  const initial = userEmail ? userEmail.charAt(0).toUpperCase() : "?";

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-surface px-4">
      <span className="font-mono text-lg font-semibold tracking-widest text-text-primary">
        FLASH
      </span>
      <StatusChip status={status} percent={percent} />
      <QuickAskBar />
      <time
        dateTime={now?.toISOString()}
        className="hidden font-mono text-sm text-text-secondary sm:block"
      >
        {now ? formatClock(now) : "…"}
      </time>
      {userEmail ? (
        <div className="relative">
          <button
            type="button"
            aria-expanded={menuOpen}
            aria-haspopup="true"
            aria-label={`Account menu for ${userEmail}`}
            onClick={() => setMenuOpen((open) => !open)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setMenuOpen(false);
            }}
            className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-surface-raised font-display text-lg font-semibold text-text-primary"
          >
            {initial}
          </button>
          {menuOpen && (
            <div
              role="menu"
              aria-label="Account"
              onKeyDown={(event) => {
                if (event.key === "Escape") setMenuOpen(false);
              }}
              className="absolute right-0 top-full mt-2 w-64 rounded-md border border-border bg-surface-raised p-2 shadow-lg"
            >
              <p className="break-all px-2 py-2 text-sm text-text-secondary">{userEmail}</p>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  void signOut();
                }}
                className="flex min-h-11 w-full items-center rounded px-2 py-2 text-left text-sm text-text-primary hover:bg-surface"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      ) : (
        <Link
          href="/login"
          className="flex min-h-11 items-center rounded-md border border-border px-3 text-sm text-text-primary"
        >
          Sign in
        </Link>
      )}
    </header>
  );
}
