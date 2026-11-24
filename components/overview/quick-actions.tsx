import Link from "next/link";
import { Panel } from "./panel";

const button =
  "flex min-h-12 items-center justify-center gap-2 rounded border border-accent-cyan/30 bg-surface-raised/80 px-3 text-base text-text-primary shadow-[inset_0_0_14px_rgb(0_229_255/0.08)] transition-colors duration-150 hover:border-accent-cyan hover:text-accent-cyan";

/**
 * Quick actions (DESIGN.md 2 and 5.8). M2 ships New task and New note,
 * each opening the real form on the Tasks & Notes screen. Review approval
 * appears only while one is open (M3-24b) and Start voice arrives in M4 —
 * neither is shown yet (DESIGN.md 9.6: features that do not exist yet are
 * not shown as buttons).
 */
export function QuickActions() {
  return (
    <Panel title="Quick Actions" tourId="quick-actions">
      <div className="grid grid-cols-2 gap-2">
        <Link href="/tasks#new-task-title" className={button}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
            className="size-4"
          >
            <path d="M4 6h16M4 12h16M4 18h10" strokeLinecap="round" />
            <path d="m18 16 2 2 3-3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          New task
        </Link>
        <Link href="/tasks#new-note-title" className={button}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
            className="size-4"
          >
            <path d="M6 3h8l4 4v14H6V3Z" strokeLinejoin="round" />
            <path d="M14 3v4h4" strokeLinejoin="round" />
            <path d="M9 12h6M9 16h6" strokeLinecap="round" />
          </svg>
          New note
        </Link>
      </div>
    </Panel>
  );
}
