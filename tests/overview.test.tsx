// Overview component tests (M2-9a): normal, empty, and unavailable states
// per component, with fixture data only — no mock data ships in the product.
// Visual comparison: docs/design/overview-mockup.png was never copied into
// this repo (binary cannot go through push-files), so the layout is checked
// against DESIGN.md §2/§5 instead (see PROGRESS.md).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TasksPanel } from "@/components/overview/tasks-panel";
import { NotesPanel } from "@/components/overview/notes-panel";
import { UsagePanelView, usageFromHealth } from "@/components/overview/usage-panel";
import { RingGauge, RingGaugeUnavailable } from "@/components/overview/ring-gauge";
import { Overview } from "@/components/overview/overview";
import { OrbPlaceholder, greetingFor } from "@/components/overview/orb";
import { QuickActions } from "@/components/overview/quick-actions";
import { TOUR_STEPS } from "@/components/overview/tour";
import type { Task } from "@/lib/tasks";
import type { Note } from "@/lib/notes";

const TODAY = "2026-11-24";
const task = (over: Partial<Task>): Task => ({
  id: "t",
  title: "Fixture task",
  due_date: null,
  status: "pending",
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  ...over,
});
const note = (over: Partial<Note>): Note => ({
  id: "n",
  title: "Fixture note",
  content: "",
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  ...over,
});
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const visibleText = (out: string) => out.replace(/<[^>]*>/g, " ").toLowerCase();

describe("TasksPanel", () => {
  it("normal: pending with due dates and overdue text, completed counted", () => {
    const out = html(
      <TasksPanel
        today={TODAY}
        tasks={[
          task({ id: "a", title: "Lab report", due_date: "2026-11-20T00:00:00+05:30" }),
          task({ id: "b", title: "Buy servo", due_date: "2026-11-28T00:00:00+05:30" }),
          task({ id: "c", title: "Done thing", status: "completed" }),
        ]}
      />,
    );
    expect(out).toContain("Lab report");
    expect(out).toContain("Overdue · 20 Nov");
    expect(out).toContain("Due 28 Nov");
    expect(out).not.toContain("Done thing");
    expect(out).toContain("1 completed");
  });

  it("empty: no tasks yet; all completed shows nothing pending", () => {
    expect(html(<TasksPanel today={TODAY} tasks={[]} />)).toContain("No tasks yet.");
    const done = html(
      <TasksPanel today={TODAY} tasks={[task({ id: "c", title: "Done thing", status: "completed" })]} />,
    );
    expect(done).toContain("Nothing pending.");
    expect(done).toContain("1 completed");
  });

  it("unavailable: failed load says Unavailable, never zero", () => {
    const out = html(<TasksPanel today={TODAY} tasks={null} />);
    expect(out).toContain("Unavailable");
    expect(out).not.toContain("No tasks yet.");
  });
});

describe("NotesPanel", () => {
  it("normal: shows the latest notes", () => {
    const out = html(
      <NotesPanel
        notes={[note({ id: "a", title: "Servo notes" }), note({ id: "b", title: "Lab journal" })]}
      />,
    );
    expect(out).toContain("Servo notes");
    expect(out).toContain("Lab journal");
  });

  it("empty: no notes yet", () => {
    expect(html(<NotesPanel notes={[]} />)).toContain("No notes yet.");
  });

  it("unavailable: failed load says Unavailable", () => {
    expect(html(<NotesPanel notes={null} />)).toContain("Unavailable");
  });
});

describe("UsagePanelView and usageFromHealth", () => {
  it("normal: gauges show real figures; limit reached is labelled", () => {
    const out = html(<UsagePanelView state={{ kind: "ok", usage: 3, cap: 20 }} tasks={{ done: 2, total: 5 }} />);
    expect(out).toContain("3 of 20");
    expect(out).toContain("2 of 5");
    expect(out).toContain("WITHIN LIMITS");
    const capped = html(<UsagePanelView state={{ kind: "ok", usage: 20, cap: 20 }} tasks={null} />);
    expect(capped).toContain("LIMIT REACHED");
    expect(capped).toContain("Unavailable");
  });

  it("loading and unavailable states", () => {
    expect(html(<UsagePanelView state={{ kind: "loading" }} />)).toContain("Loading");
    const failed = html(<UsagePanelView state={{ kind: "unavailable" }} />);
    expect(failed).toContain("Unavailable");
    expect(failed).not.toMatch(/\b0 of\b/);
  });

  it("usageFromHealth: anything but a well-formed 200 is unavailable", () => {
    expect(usageFromHealth(true, { usage: 2, cap: 20 })).toEqual({ kind: "ok", usage: 2, cap: 20 });
    expect(usageFromHealth(false, { usage: 2, cap: 20 })).toEqual({ kind: "unavailable" });
    expect(usageFromHealth(true, { error: "unauthenticated" })).toEqual({ kind: "unavailable" });
    expect(usageFromHealth(true, null)).toEqual({ kind: "unavailable" });
    expect(usageFromHealth(true, { usage: "3", cap: 20 })).toEqual({ kind: "unavailable" });
  });
});

describe("RingGauge", () => {
  it("clamps the ring but shows the true number", () => {
    const out = html(<RingGauge value={120} max={100} label="Model calls today" />);
    expect(out).toContain("120 of 100");
    expect(out).toContain('aria-hidden="true"');
  });

  it("unavailable gauge keeps the label and says Unavailable", () => {
    const out = html(<RingGaugeUnavailable label="Tasks done" />);
    expect(out).toContain("Tasks done");
    expect(out).toContain("Unavailable");
  });
});

describe("OrbPlaceholder", () => {
  it("each state is a distinct silhouette, not just a colour change", () => {
    expect(html(<OrbPlaceholder state="listening" />)).toContain("flash-orb-listening-ring");
    expect(html(<OrbPlaceholder state="thinking" />)).toContain("flash-orb-thinking-spin");
    expect(html(<OrbPlaceholder state="speaking" />)).toContain("flash-orb-speaking-pulse");
    expect(html(<OrbPlaceholder state="idle" />)).not.toContain("flash-orb-listening-ring");
    expect(html(<OrbPlaceholder state="idle" />)).not.toContain("flash-orb-thinking-spin");
    expect(html(<OrbPlaceholder state="error" />)).toContain("#f87171");
  });

  it("greets by time of day", () => {
    expect(greetingFor(8)).toBe("Good morning.");
    expect(greetingFor(14)).toBe("Good afternoon.");
    expect(greetingFor(20)).toBe("Good evening.");
    expect(greetingFor(2)).toBe("Good evening.");
  });
});

describe("QuickActions", () => {
  it("shows New task and New note only — Review approval and Start voice come later", () => {
    const out = html(<QuickActions />);
    expect(out).toContain("New task");
    expect(out).toContain("New note");
    expect(out).toContain('href="/tasks#new-task-title"');
    expect(out).toContain('href="/tasks#new-note-title"');
    const text = visibleText(out);
    expect(text).not.toContain("review approval");
    expect(text).not.toContain("start voice");
    expect(text).not.toContain("voice chat");
  });
});

describe("Overview", () => {
  it("shows no fake telemetry and no M3 panels", () => {
    // Visible text only: class names such as "flash-frame" contain "ram".
    const out = visibleText(html(<Overview usage={null} tasks={[]} notes={[]} today={TODAY} />));
    for (const absent of [
      "cpu",
      "ram",
      "thermal",
      "review approval",
      "deploy code",
      "database query",
      "autonomous",
      "network sync",
    ]) {
      expect(out).not.toContain(absent);
    }
    expect(out).toContain("new task");
    expect(out).toContain("new note");
    expect(out).toContain("take the tour");
  });

  it("three-zone layout: orb centre, usage/notes left, tasks/actions right", () => {
    const out = html(
      <Overview
        usage={<p>USAGE SLOT</p>}
        tasks={[task({ title: "T1" })]}
        notes={[note({ title: "N1" })]}
        today={TODAY}
      />,
    );
    expect(out).toContain("USAGE SLOT");
    expect(out).toContain("T1");
    expect(out).toContain("N1");
    expect(out).toContain("Central intelligence");
    expect(out).toContain("xl:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)_minmax(0,1fr)]");
  });

  it("failed loads show Unavailable on the assembled page, never zero", () => {
    const out = html(<Overview usage={<UsagePanelView state={{ kind: "unavailable" }} />} tasks={null} notes={null} today={TODAY} />);
    expect(out.match(/Unavailable/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe("Tour steps", () => {
  it("has the 8-step cinematic flow with the orb morphing per step", () => {
    expect(TOUR_STEPS).toHaveLength(8);
    expect(TOUR_STEPS.map((s) => s.id)).toEqual([
      "welcome",
      "orb",
      "wave",
      "usage",
      "approvals",
      "tasks",
      "quick-actions",
      "finale",
    ]);
    expect(TOUR_STEPS[1].orbState).toBe("listening");
    expect(TOUR_STEPS[2].orbState).toBe("speaking");
    expect(TOUR_STEPS[3].orbState).toBe("thinking");
    expect(TOUR_STEPS[4].target).toBe("approvals");
  });
});
