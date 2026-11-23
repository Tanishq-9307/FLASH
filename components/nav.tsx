// Navigation shell (M1-8, DESIGN.md §5.1/§5.2/§8).
//
// Desktop (>=768px): an 88px icon rail, labels under icons, active item in
// cyan with icon and text. Mobile (<768px): a bottom tab bar with Overview,
// Chat, Tasks, Activity, and a More button that opens Memory and Settings.
// Both switch by CSS breakpoint classes, so there is no load flash. Touch
// targets are at least 44px; focus uses the global :focus-visible ring.
//
// Screens that are not built yet render a clear "not built yet" page (see
// components/not-built-yet.tsx), never fake content.
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

type IconProps = { className?: string };

function OverviewIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="3" width="8" height="8" rx="1" />
      <rect x="3" y="13" width="8" height="8" rx="1" />
      <rect x="13" y="13" width="8" height="8" rx="1" />
    </svg>
  );
}

function ChatIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="M4 5h16v11H9l-5 4V5Z" strokeLinejoin="round" />
    </svg>
  );
}

function TasksIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="m4 6 1.5 1.5L8 5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 6h9M11 12h9M11 18h9" strokeLinecap="round" />
      <path d="m4 12 1.5 1.5L8 11" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m4 18 1.5 1.5L8 17" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MemoryIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M8 7.5 10.5 16M16 7.5 13.5 16M8.5 6h7" />
    </svg>
  );
}

function ActivityIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="M3 12h4l3-8 4 16 3-8h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SettingsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" strokeLinecap="round" />
      <circle cx="16" cy="7" r="2.5" />
      <circle cx="10" cy="17" r="2.5" />
    </svg>
  );
}

function MoreIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

type NavItem = {
  href: string;
  label: string;
  shortLabel: string;
  Icon: (props: IconProps) => React.ReactElement;
};

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Overview", shortLabel: "Overview", Icon: OverviewIcon },
  { href: "/chat", label: "Chat", shortLabel: "Chat", Icon: ChatIcon },
  { href: "/tasks", label: "Tasks & Notes", shortLabel: "Tasks", Icon: TasksIcon },
  { href: "/memory", label: "Memory", shortLabel: "Memory", Icon: MemoryIcon },
  { href: "/activity", label: "Activity", shortLabel: "Activity", Icon: ActivityIcon },
  { href: "/settings", label: "Settings", shortLabel: "Settings", Icon: SettingsIcon },
];

// The tab bar shows four items plus More; Memory and Settings live in the
// More menu (DESIGN.md §5.2).
const TAB_BAR_ITEMS = NAV_ITEMS.filter((item) =>
  ["/", "/chat", "/tasks", "/activity"].includes(item.href),
);
const MORE_ITEMS = NAV_ITEMS.filter((item) =>
  ["/memory", "/settings"].includes(item.href),
);

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({
  item,
  active,
  className,
  indicator,
}: {
  item: NavItem;
  active: boolean;
  className: string;
  // Visible active marker besides colour (DESIGN.md §8): a cyan bar on the
  // rail's inner edge, or across the tab bar item's top edge.
  indicator: "left" | "top";
}) {
  const { Icon } = item;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`${className} ${active ? "text-accent-cyan" : "text-text-secondary hover:text-text-primary"}`}
    >
      {active && (
        <span
          aria-hidden="true"
          className={
            indicator === "left"
              ? "absolute top-2 bottom-2 left-0 w-[3px] rounded-r bg-accent-cyan"
              : "absolute top-0 right-4 left-4 h-[3px] rounded-b bg-accent-cyan"
          }
        />
      )}
      <Icon className="h-6 w-6" />
      <span>{item.label}</span>
    </Link>
  );
}

export function NavRail() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="fixed top-0 bottom-0 left-0 z-40 hidden w-[88px] flex-col items-stretch border-r border-border bg-surface md:flex"
    >
      <div className="flex h-16 items-center justify-center border-b border-border">
        <span className="font-display text-lg font-bold tracking-widest text-text-primary">
          FLASH
        </span>
      </div>
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.href}
          item={item}
          active={isActive(pathname, item.href)}
          indicator="left"
          className="relative flex min-h-11 flex-1 flex-col items-center justify-center gap-1 py-2 text-xs"
        />
      ))}
    </nav>
  );
}

export function MobileTabBar() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  function closeMore() {
    setMoreOpen(false);
  }

  return (
    <nav
      aria-label="Mobile"
      className="fixed right-0 bottom-0 left-0 z-40 flex border-t border-border bg-surface md:hidden"
    >
      {TAB_BAR_ITEMS.map((item) => (
        <NavLink
          key={item.href}
          item={{ ...item, label: item.shortLabel }}
          active={isActive(pathname, item.href)}
          indicator="top"
          className="relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 py-1 text-xs"
        />
      ))}
      <div className="relative flex flex-1">
        <button
          type="button"
          aria-expanded={moreOpen}
          aria-haspopup="true"
          aria-label="More navigation"
          onClick={() => setMoreOpen((open) => !open)}
          onKeyDown={(event) => {
            if (event.key === "Escape") closeMore();
          }}
          className={`flex min-h-14 w-full flex-col items-center justify-center gap-0.5 py-1 text-xs ${
            moreOpen || MORE_ITEMS.some((item) => isActive(pathname, item.href))
              ? "text-accent-cyan"
              : "text-text-secondary hover:text-text-primary"
          }`}
        >
          <MoreIcon className="h-6 w-6" />
          <span>More</span>
        </button>
        {moreOpen && (
          <div
            role="menu"
            aria-label="More"
            onKeyDown={(event) => {
              if (event.key === "Escape") closeMore();
            }}
            className="absolute right-2 bottom-full mb-2 w-48 rounded-md border border-border bg-surface-raised p-1 shadow-lg"
          >
            {MORE_ITEMS.map((item) => {
              const { Icon } = item;
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  role="menuitem"
                  aria-current={active ? "page" : undefined}
                  onClick={closeMore}
                  className={`flex min-h-11 items-center gap-3 rounded px-3 py-2 text-sm ${
                    active ? "text-accent-cyan" : "text-text-secondary hover:text-text-primary"
                  }`}
                >
                  <Icon className="h-5 w-5" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </nav>
  );
}
