// Notes (M2-8b, DESIGN.md §5.1). Note text is shown as plain text,
// never as HTML. A note appears or changes only after the server
// returns the committed row (DESIGN.md §9, rule 2). Icons are inline
// SVGs in the same style as components/nav.tsx (no icon dependency in
// this repo).
"use client";

import { useState, useTransition } from "react";
import {
  createNote,
  deleteNote,
  editNote,
  searchNotes,
  type NoteActionError,
} from "@/app/tasks/note-actions";
import {
  MAX_NOTE_CONTENT,
  MAX_NOTE_TITLE,
  MAX_SEARCH_CHARS,
  type Note,
} from "@/lib/notes";
import { insertAtCursor } from "@/lib/clipboard";
import { PasteFromClipboardButton } from "./clipboard-paste-button";

const ERRORS: Record<NoteActionError, string> = {
  invalid:
    "A note needs a title of 1 to 255 characters and at most 100,000 characters of text. Searches need 1 to 200 characters.",
  not_found: "That note no longer exists.",
  unauthenticated: "You are signed out. Sign in again.",
  unavailable: "Could not reach the database. Nothing was changed.",
};

const iconButton =
  "flex size-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:text-text-primary disabled:opacity-50";
const field =
  "rounded-md border border-border-strong bg-background px-3 text-text-primary";

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

function SearchIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" strokeLinecap="round" />
    </svg>
  );
}

const updatedLabel = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  }).format(new Date(iso));

export function NoteBoard({ initial }: { initial: Note[] }) {
  const [notes, setNotes] = useState(initial);
  const [results, setResults] = useState<{ query: string; notes: Note[] } | null>(null);
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Clipboard paste (Phase 1): failure message for the new-note form.
  // Pasted text is appended to the content field, never saved until
  // the user presses "Save note".
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const show = (result: { ok: true } | { ok: false; error: NoteActionError }) =>
    setError(result.ok ? null : ERRORS[result.error]);
  const saved = (row: Note) => {
    const swap = (list: Note[]) => [row, ...list.filter((n) => n.id !== row.id)];
    setNotes(swap);
    setResults((r) =>
      r && r.notes.some((n) => n.id === row.id)
        ? { ...r, notes: r.notes.map((n) => (n.id === row.id ? row : n)) }
        : r,
    );
  };
  const removed = (id: string) => {
    setNotes((list) => list.filter((n) => n.id !== id));
    setResults((r) => (r ? { ...r, notes: r.notes.filter((n) => n.id !== id) } : r));
  };

  const shown = results ? results.notes : notes;

  return (
    <section aria-labelledby="notes-title" className="flash-frame p-4">
      <h2
        id="notes-title"
        className="font-display text-[1.375rem] leading-7 font-semibold uppercase tracking-[0.03em] text-text-primary"
      >
        Notes
      </h2>

      <form
        role="search"
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          startTransition(async () => {
            const result = await searchNotes(query);
            show(result);
            if (result.ok) setResults({ query: query.trim(), notes: result.data });
          });
        }}
      >
        <label htmlFor="note-search" className="sr-only">
          Search notes
        </label>
        <input
          id="note-search"
          type="search"
          value={query}
          maxLength={MAX_SEARCH_CHARS}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search notes"
          className={`${field} h-11 min-w-0 flex-1`}
        />
        <button
          type="submit"
          disabled={pending || !query.trim()}
          aria-label="Search"
          className={`${iconButton} border border-border-strong`}
        >
          <SearchIcon className="size-4" />
        </button>
        {results ? (
          <button
            type="button"
            aria-label="Clear search"
            className={iconButton}
            onClick={() => {
              setResults(null);
              setQuery("");
            }}
          >
            <CloseIcon className="size-4" />
          </button>
        ) : null}
      </form>

      <details className="mt-3 rounded-md border border-border p-3">
        <summary className="min-h-11 cursor-pointer content-center">New note</summary>
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            startTransition(async () => {
              const result = await createNote({ title, content });
              show(result);
              if (result.ok) {
                saved(result.data);
                setTitle("");
                setContent("");
              }
            });
          }}
        >
          <label htmlFor="new-note-title" className="text-sm text-text-secondary">
            Title
          </label>
          <input
            id="new-note-title"
            value={title}
            maxLength={MAX_NOTE_TITLE}
            onChange={(e) => setTitle(e.target.value)}
            className={`${field} h-11`}
          />
          <div className="flex items-end justify-between gap-2">
            <label htmlFor="new-note-content" className="text-sm text-text-secondary">
              Text
            </label>
            <PasteFromClipboardButton
              onPaste={(text) =>
                setContent((prev) => insertAtCursor(prev, text).value)
              }
              onNotice={setPasteNotice}
            />
          </div>
          <textarea
            id="new-note-content"
            value={content}
            maxLength={MAX_NOTE_CONTENT}
            onChange={(e) => setContent(e.target.value)}
            rows={4}
            className={`${field} py-2`}
          />
          <button
            type="submit"
            disabled={pending || !title.trim()}
            className="h-11 self-start rounded-md bg-accent-cyan px-4 text-on-accent disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save note"}
          </button>
        </form>
      </details>

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

      {results ? (
        <p
          role="status"
          className="mt-3 font-display text-sm font-semibold uppercase tracking-[0.08em] text-text-secondary"
        >
          {results.notes.length} {results.notes.length === 1 ? "note matches" : "notes match"}{" "}
          &ldquo;{results.query}&rdquo;
        </p>
      ) : null}

      {shown.length === 0 ? (
        <p className="mt-4 text-text-secondary">
          {results ? "No notes match. Try other words." : "No notes yet. Add one above."}
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {shown.map((note) => (
            <NoteRow key={note.id} note={note} onSaved={saved} onRemoved={removed} onResult={show} />
          ))}
        </ul>
      )}
    </section>
  );
}

function NoteRow({
  note,
  onSaved,
  onRemoved,
  onResult,
}: {
  note: Note;
  onSaved: (row: Note) => void;
  onRemoved: (id: string) => void;
  onResult: (result: { ok: true } | { ok: false; error: NoteActionError }) => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [pending, startTransition] = useTransition();

  if (mode === "edit") {
    return (
      <li className="rounded-md border border-border-strong p-3">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            startTransition(async () => {
              const result = await editNote(note.id, { title, content });
              onResult(result);
              if (result.ok) {
                onSaved(result.data);
                setMode("view");
              }
            });
          }}
        >
          <label htmlFor={`note-title-${note.id}`} className="sr-only">
            Title
          </label>
          <input
            id={`note-title-${note.id}`}
            value={title}
            maxLength={MAX_NOTE_TITLE}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            className={`${field} h-11`}
          />
          <label htmlFor={`note-content-${note.id}`} className="sr-only">
            Text
          </label>
          <textarea
            id={`note-content-${note.id}`}
            value={content}
            maxLength={MAX_NOTE_CONTENT}
            onChange={(e) => setContent(e.target.value)}
            rows={5}
            className={`${field} py-2`}
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={pending}
              className="flex h-11 items-center gap-1 rounded-md bg-accent-cyan px-4 text-on-accent"
            >
              <CheckIcon className="size-4" /> Save
            </button>
            <button
              type="button"
              className="h-11 rounded-md border border-border-strong px-4"
              onClick={() => {
                setTitle(note.title);
                setContent(note.content);
                setMode("view");
                onResult({ ok: true });
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="break-words font-medium">{note.title}</h3>
          <p className="font-mono text-xs text-text-secondary">
            Updated {updatedLabel(note.updated_at)}
          </p>
        </div>
        {mode === "view" ? (
          <span className="flex">
            <button
              type="button"
              aria-label={`Edit ${note.title}`}
              className={iconButton}
              onClick={() => setMode("edit")}
            >
              <PencilIcon className="size-4" />
            </button>
            <button
              type="button"
              aria-label={`Delete ${note.title}`}
              className={iconButton}
              onClick={() => setMode("confirm")}
            >
              <TrashIcon className="size-4" />
            </button>
          </span>
        ) : null}
      </div>
      {note.content ? (
        <p className="mt-2 line-clamp-4 whitespace-pre-wrap break-words text-sm text-text-secondary">
          {note.content}
        </p>
      ) : null}
      {mode === "confirm" ? (
        <div className="mt-2 flex items-center gap-2 text-sm">
          Delete this note?
          <button
            type="button"
            disabled={pending}
            className="h-11 rounded-md bg-danger px-3 text-on-accent"
            onClick={() =>
              startTransition(async () => {
                const result = await deleteNote(note.id);
                onResult(result);
                if (result.ok) onRemoved(note.id);
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
        </div>
      ) : null}
    </li>
  );
}
