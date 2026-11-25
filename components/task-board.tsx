// Tasks screen (M2-8a, DESIGN.md §5.1, DATABASE.md §3.5). A task appears
// or changes only after the server returns the committed row (DESIGN.md
// §9, rule 2). Icons are inline SVGs in the same style as
// components/nav.tsx (no icon dependency in this repo).
"use client";

import { useState, useTransition } from "react";
import {
  createTask,
  deleteTask,
  editTask,
  setTaskStatus,
  type TaskActionError,
} from "@/app/tasks/actions";
import {
  MAX_TASK_TITLE,
  sortTasks,
  timestampToDueDay,
  type Task,
} from "@/lib/tasks";
import { insertAtCursor } from "@/lib/clipboard";
import { PasteFromClipboardButton } from "./clipboard-paste-button";

const ERRORS: Record<TaskActionError, string> = {
  invalid: "A task needs a title of 1 to 255 characters and a real date.",
  not_found: "That task no longer exists.",
  unauthenticated: "You are signed out. Sign in again.",
  unavailable: "Could not reach the database. Nothing was changed.",
};

const iconButton =
  "flex size-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:text-text-primary disabled:opacity-50";
const field =
  "h-11 rounded-md border border-border-strong bg-background px-3 text-text-primary";

type IconProps = { className?: string };

function CheckIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="m4 12.5 5 5L20 6.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
    </svg>
  );
}

function PencilIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="M4 20h4L20 8l-4-4L4 16v4Z" strokeLinejoin="round" />
      <path d="m13.5 6.5 4 4" />
    </svg>
  );
}

function TrashIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CalendarIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="1" />
      <path d="M3 10h18M8 3v4M16 3v4" strokeLinecap="round" />
    </svg>
  );
}

function formatDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function TaskBoard({ initial, today }: { initial: Task[]; today: string }) {
  const [tasks, setTasks] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [dueDay, setDueDay] = useState("");
  // Clipboard paste (Phase 1): failure message for the new-task form.
  // Pasted text is appended to the title field, never saved until the
  // user presses "Add task".
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const put = (row: Task) =>
    setTasks((all) => sortTasks([...all.filter((t) => t.id !== row.id), row]));
  const show = (result: { ok: true } | { ok: false; error: TaskActionError }) =>
    setError(result.ok ? null : ERRORS[result.error]);

  const open = tasks.filter((t) => t.status === "pending");
  const done = tasks.filter((t) => t.status !== "pending");

  return (
    <section aria-labelledby="tasks-title" className="flash-frame p-4">
      <h2
        id="tasks-title"
        className="font-display text-[1.375rem] leading-7 font-semibold uppercase tracking-[0.03em] text-text-primary"
      >
        Tasks
      </h2>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          startTransition(async () => {
            const result = await createTask({ title, dueDay });
            show(result);
            if (result.ok) {
              put(result.data);
              setTitle("");
              setDueDay("");
            }
          });
        }}
      >
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <label htmlFor="new-task-title" className="text-sm text-text-secondary">
            New task
          </label>
          <input
            id="new-task-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={MAX_TASK_TITLE}
            className={field}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="new-task-due" className="text-sm text-text-secondary">
            Due date (optional)
          </label>
          <input
            id="new-task-due"
            type="date"
            value={dueDay}
            onChange={(e) => setDueDay(e.target.value)}
            className={field}
          />
        </div>
        <button
          type="submit"
          disabled={pending || !title.trim()}
          className="h-11 rounded-md bg-accent-cyan px-4 text-on-accent disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add task"}
        </button>
        <PasteFromClipboardButton
          onPaste={(text) =>
            setTitle((prev) => insertAtCursor(prev, text).value)
          }
          onNotice={setPasteNotice}
        />
      </form>
      {pasteNotice ? (
        <p role="status" className="mt-3 text-sm text-text-secondary">
          {pasteNotice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {tasks.length === 0 ? (
        <p className="mt-4 text-text-secondary">No tasks yet. Add one above.</p>
      ) : (
        <>
          <TaskList
            label="To do"
            tasks={open}
            today={today}
            onSaved={put}
            onRemoved={(id) => setTasks((all) => all.filter((t) => t.id !== id))}
            onResult={show}
          />
          {done.length > 0 ? (
            <TaskList
              label="Completed"
              tasks={done}
              today={today}
              onSaved={put}
              onRemoved={(id) => setTasks((all) => all.filter((t) => t.id !== id))}
              onResult={show}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

type RowProps = {
  today: string;
  onSaved: (row: Task) => void;
  onRemoved: (id: string) => void;
  onResult: (result: { ok: true } | { ok: false; error: TaskActionError }) => void;
};

function TaskList({
  label,
  tasks,
  ...props
}: { label: string; tasks: Task[] } & RowProps) {
  return (
    <div className="mt-4">
      <h3 className="font-display text-sm font-semibold uppercase tracking-[0.08em] text-text-secondary">
        {label} ({tasks.length})
      </h3>
      {tasks.length === 0 ? (
        <p className="mt-2 text-sm text-text-secondary">Nothing to do. Nice.</p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-border">
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} {...props} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TaskRow({ task, today, onSaved, onRemoved, onResult }: { task: Task } & RowProps) {
  const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
  const [title, setTitle] = useState(task.title);
  const [dueDay, setDueDay] = useState(timestampToDueDay(task.due_date));
  const [pending, startTransition] = useTransition();
  const completed = task.status === "completed";
  const day = timestampToDueDay(task.due_date);
  const overdue = !completed && day !== "" && day < today;

  if (mode === "edit") {
    return (
      <li className="py-2">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            startTransition(async () => {
              const result = await editTask(task.id, { title, dueDay });
              onResult(result);
              if (result.ok) {
                onSaved(result.data);
                setMode("view");
              }
            });
          }}
        >
          <label className="sr-only" htmlFor={`title-${task.id}`}>
            Task title
          </label>
          <input
            id={`title-${task.id}`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={MAX_TASK_TITLE}
            autoFocus
            className={`${field} min-w-40 flex-1`}
          />
          <label className="sr-only" htmlFor={`due-${task.id}`}>
            Due date
          </label>
          <input
            id={`due-${task.id}`}
            type="date"
            value={dueDay}
            onChange={(e) => setDueDay(e.target.value)}
            className={field}
          />
          <button type="submit" disabled={pending} aria-label="Save task" className={iconButton}>
            <CheckIcon className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Cancel edit"
            className={iconButton}
            onClick={() => {
              setTitle(task.title);
              setDueDay(day);
              setMode("view");
              onResult({ ok: true });
            }}
          >
            <CloseIcon className="size-4" />
          </button>
        </form>
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center gap-2 py-1">
      <label className="flex min-h-11 min-w-0 flex-1 basis-full cursor-pointer items-center gap-3 sm:basis-0">
        <input
          type="checkbox"
          checked={completed}
          disabled={pending}
          onChange={() =>
            startTransition(async () => {
              const result = await setTaskStatus(
                task.id,
                completed ? "pending" : "completed",
              );
              onResult(result);
              if (result.ok) onSaved(result.data);
            })
          }
          className="size-5 accent-[var(--color-accent-cyan)]"
        />
        <span
          className={`min-w-0 break-words ${completed ? "text-text-secondary line-through" : ""}`}
        >
          {task.title}
        </span>
      </label>
      {day ? (
        <span
          className={`ml-8 flex items-center gap-1 font-mono text-xs sm:ml-0 ${overdue ? "text-danger" : "text-text-secondary"}`}
        >
          <CalendarIcon className="size-3.5" />
          {overdue ? "Overdue · " : "Due "}
          {formatDay(day)}
        </span>
      ) : null}
      {mode === "confirm" ? (
        <span className="flex items-center gap-2 text-sm">
          Delete this task?
          <button
            type="button"
            disabled={pending}
            className="h-11 rounded-md bg-danger px-3 text-on-accent"
            onClick={() =>
              startTransition(async () => {
                const result = await deleteTask(task.id);
                onResult(result);
                if (result.ok) onRemoved(task.id);
                else setMode("view");
              })
            }
          >
            {pending ? "Deleting…" : "Delete"}
          </button>
          <button
            type="button"
            className="h-11 rounded-md border border-border-strong px-3"
            onClick={() => setMode("view")}
          >
            Keep
          </button>
        </span>
      ) : (
        <span className="flex">
          <button
            type="button"
            aria-label={`Edit ${task.title}`}
            className={iconButton}
            onClick={() => setMode("edit")}
          >
            <PencilIcon className="size-4" />
          </button>
          <button
            type="button"
            aria-label={`Delete ${task.title}`}
            className={iconButton}
            onClick={() => setMode("confirm")}
          >
            <TrashIcon className="size-4" />
          </button>
        </span>
      )}
    </li>
  );
}
