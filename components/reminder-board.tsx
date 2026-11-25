// Reminders screen (Phase 3, 2026-11-25, DESIGN.md §5.1). A
// reminder appears or changes only after the server returns the
// committed row (DESIGN.md §9, rule 2). Icons are inline SVGs in the
// same style as components/nav.tsx (no icon dependency in this repo).
//
// The time input is a datetime-local field: the value is a
// wall-clock reading in India, converted to an Asia/Kolkata
// timestamp before it is sent (datetimeLocalToTimestamp). There is
// no edit: a wrong reminder is deleted and set again, so a row's
// time can never silently change after it was set.
"use client";

import { useState, useTransition } from "react";
import {
  cancelReminder,
  createReminder,
  deleteReminder,
  type ReminderActionError,
} from "@/app/reminders/actions";
import {
  datetimeLocalToTimestamp,
  MAX_REMINDER_MESSAGE,
  sortReminders,
  type Reminder,
} from "@/lib/reminders/reminders";
import { formatReminderTime } from "@/lib/reminders/parse-time";

const ERRORS: Record<ReminderActionError, string> = {
  invalid:
    "A reminder needs a message of 1 to 500 characters and a future date and time.",
  not_found: "That reminder no longer exists.",
  unauthenticated: "You are signed out. Sign in again.",
  unavailable: "Could not reach the database. Nothing was changed.",
};

const iconButton =
  "flex size-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:text-text-primary disabled:opacity-50";
const field =
  "h-11 rounded-md border border-border-strong bg-background px-3 text-text-primary";

type IconProps = { className?: string };

function CloseIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
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

function BellIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="M18 9a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7" strokeLinejoin="round" />
      <path d="M10 20a2 2 0 0 0 4 0" strokeLinecap="round" />
    </svg>
  );
}

function ReminderList({
  label,
  reminders,
  onSaved,
  onRemoved,
}: {
  label: string;
  reminders: Reminder[];
  onSaved: (row: Reminder) => void;
  onRemoved: (id: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (reminders.length === 0) return null;
  return (
    <div className="mt-4">
      <h3 className="font-display text-lg font-semibold uppercase tracking-[0.03em] text-text-primary">
        {label} ({reminders.length})
      </h3>
      <ul className="mt-2 flex flex-col gap-2">
        {reminders.map((reminder) => (
          <li
            key={reminder.id}
            className="flex items-center gap-2 rounded-md border border-border bg-surface-raised px-3 py-2"
          >
            <BellIcon className="h-5 w-5 shrink-0 text-accent-cyan" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-text-primary">{reminder.message}</p>
              <p className="text-sm text-text-secondary">
                {formatReminderTime(reminder.remind_at)}
                {reminder.status === "sent" ? " · Sent" : ""}
                {reminder.status === "cancelled" ? " · Cancelled" : ""}
                {reminder.source === "telegram" ? " · via Telegram" : ""}
                {reminder.source === "chat" ? " · via chat" : ""}
              </p>
            </div>
            {reminder.status === "pending" ? (
              <button
                type="button"
                aria-label={`Cancel reminder: ${reminder.message}`}
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await cancelReminder(reminder.id);
                    if (result.ok) onSaved(result.data);
                    else setError(ERRORS[result.error]);
                  })
                }
                className={iconButton}
              >
                <CloseIcon className="h-5 w-5" />
              </button>
            ) : null}
            <button
              type="button"
              aria-label={`Delete reminder: ${reminder.message}`}
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await deleteReminder(reminder.id);
                  if (result.ok) onRemoved(result.data.id);
                  else setError(ERRORS[result.error]);
                })
              }
              className={iconButton}
            >
              <TrashIcon className="h-5 w-5" />
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ReminderBoard({ initial }: { initial: Reminder[] }) {
  const [reminders, setReminders] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [when, setWhen] = useState("");
  const [pending, startTransition] = useTransition();

  const put = (row: Reminder) =>
    setReminders((all) =>
      sortReminders([...all.filter((r) => r.id !== row.id), row]),
    );

  const pendingReminders = reminders.filter(
    (r) => r.status === "pending" || r.status === "sending",
  );
  const sent = reminders.filter((r) => r.status === "sent");
  const cancelled = reminders.filter((r) => r.status === "cancelled");

  return (
    <section aria-labelledby="reminders-title" className="flash-frame p-4">
      <h2
        id="reminders-title"
        className="font-display text-[1.375rem] leading-7 font-semibold uppercase tracking-[0.03em] text-text-primary"
      >
        Reminders
      </h2>
      <p className="mt-1 text-sm text-text-secondary">
        Reminders arrive on Telegram at the exact time you set — even at
        night. You can also set one in chat or with /remind on Telegram.
      </p>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!when) {
            setError("Pick a date and time for the reminder.");
            return;
          }
          startTransition(async () => {
            const result = await createReminder({
              message,
              remindAt: datetimeLocalToTimestamp(when),
            });
            if (result.ok) {
              setError(null);
              put(result.data);
              setMessage("");
              setWhen("");
            } else {
              setError(ERRORS[result.error]);
            }
          });
        }}
      >
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <label htmlFor="new-reminder-message" className="text-sm text-text-secondary">
            Remind me about
          </label>
          <input
            id="new-reminder-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={MAX_REMINDER_MESSAGE}
            placeholder="Submit the form"
            className={field}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="new-reminder-when" className="text-sm text-text-secondary">
            Date and time
          </label>
          <input
            id="new-reminder-when"
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className={field}
          />
        </div>
        <button
          type="submit"
          disabled={pending || !message.trim() || !when}
          className="h-11 rounded-md bg-accent-cyan px-4 text-on-accent disabled:opacity-50"
        >
          {pending ? "Setting…" : "Set reminder"}
        </button>
      </form>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {reminders.length === 0 ? (
        <p className="mt-4 text-text-secondary">
          No reminders yet. Set one above, or in chat — “remind me tomorrow
          at 9am to submit the form”.
        </p>
      ) : (
        <>
          <ReminderList
            label="Pending"
            reminders={pendingReminders}
            onSaved={put}
            onRemoved={(id) =>
              setReminders((all) => all.filter((r) => r.id !== id))
            }
          />
          <ReminderList
            label="Sent"
            reminders={sent}
            onSaved={put}
            onRemoved={(id) =>
              setReminders((all) => all.filter((r) => r.id !== id))
            }
          />
          <ReminderList
            label="Cancelled"
            reminders={cancelled}
            onSaved={put}
            onRemoved={(id) =>
              setReminders((all) => all.filter((r) => r.id !== id))
            }
          />
        </>
      )}
    </section>
  );
}
