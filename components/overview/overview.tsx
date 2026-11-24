"use client";

import { useState, type CSSProperties } from "react";
import type { Note } from "@/lib/notes";
import type { Task } from "@/lib/tasks";
import type { ActivityLogRow } from "@/lib/activity";
import type { CapabilityChip } from "@/lib/tools/registry";
import type { OpenApproval } from "@/app/approvals/actions";
import { ActivityPanel } from "./activity-panel";
import { CapabilityChips } from "./capability-chips";
import { NotesPanel } from "./notes-panel";
import { OrbPanel } from "./orb";
import { QuickActions } from "./quick-actions";
import { TasksPanel } from "./tasks-panel";
import { BootOverlay } from "./boot-overlay";
import { TOUR_STEPS, Tour } from "./tour";

/**
 * Overview layout (DESIGN.md 5.2). 1280px and up: three zones (left panels,
 * centre orb, right panels). 768 to 1279px: orb full width on top, panels in
 * two columns. Below 768px: one column, smaller orb.
 * Every panel takes its data through props; null means "failed to load".
 * The M3 panels (open approvals, capability chips, activity) are wired in
 * M3-24b; an undefined prop means the caller did not supply that panel
 * (older tests) and it is not rendered.
 *
 * Motion (DESIGN.md 7): the zones enter with a staggered rise; the cinematic
 * boot overlay plays once per session; the guided tour replays the entrance
 * (the grid remounts on tour start) and morphs the orb live per step.
 */
export function Overview({
  usage,
  tasks,
  notes,
  today,
  openApprovals,
  activity,
  chips,
}: {
  usage: React.ReactNode;
  tasks: Task[] | null;
  notes: Note[] | null;
  today: string;
  /** Pending approvals, or null when the load failed. */
  openApprovals?: OpenApproval[] | null;
  /** Latest activity rows, or null when the load failed. */
  activity?: ActivityLogRow[] | null;
  /** Capability chips from the registry, or null when the load failed. */
  chips?: CapabilityChip[] | null;
}) {
  const [tourOpen, setTourOpen] = useState(false);
  const [tourStep, setTourStep] = useState(0);
  const [enterKey, setEnterKey] = useState(0);

  const startTour = () => {
    setTourStep(0);
    setEnterKey((k) => k + 1); // replay the staggered panel entrances
    setTourOpen(true);
  };

  return (
    <>
      <BootOverlay />
      <Tour open={tourOpen} step={tourStep} onStepChange={setTourStep} onClose={() => setTourOpen(false)} />
      <div
        key={enterKey}
        className="mx-auto grid max-w-[1760px] gap-4 p-4 md:grid-cols-2 md:p-5 xl:min-h-[calc(100dvh-72px)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)_minmax(0,1fr)]"
      >
        <h1 className="sr-only">Overview</h1>
        <div
          className="flash-enter md:col-span-2 xl:order-2 xl:col-span-1"
          style={{ "--enter-delay": "0ms" } as CSSProperties}
        >
          <OrbPanel tourOrbState={tourOpen ? TOUR_STEPS[tourStep].orbState : undefined} onTakeTour={startTour} />
          {chips !== undefined ? (
            <div className="mt-4">
              <CapabilityChips chips={chips} />
            </div>
          ) : null}
        </div>
        <div
          className="flash-enter flex flex-col gap-4 xl:order-1 [&>*:last-child]:flex-1"
          style={{ "--enter-delay": "120ms" } as CSSProperties}
        >
          {usage}
          <NotesPanel notes={notes} />
        </div>
        <div
          className="flash-enter flex flex-col gap-4 xl:order-3 [&>*:nth-child(2)]:flex-1"
          style={{ "--enter-delay": "240ms" } as CSSProperties}
        >
          <TasksPanel tasks={tasks} today={today} openApprovals={openApprovals} />
          <QuickActions
            openApproval={openApprovals && openApprovals.length > 0 ? openApprovals[0] : null}
          />
          {activity !== undefined ? <ActivityPanel rows={activity} /> : null}
        </div>
      </div>
    </>
  );
}
