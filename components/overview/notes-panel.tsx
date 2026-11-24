import Link from "next/link";
import type { Note } from "@/lib/notes";
import { Panel, Unavailable } from "./panel";

const SHOWN = 4;

/** Recent Notes (DESIGN.md 2, replaces "Projects & Knowledge"). null = failed load. */
export function NotesPanel({ notes }: { notes: Note[] | null }) {
  return (
    <Panel
      title="Recent Notes"
      action={
        <Link
          href="/tasks#notes-title"
          className="flex min-h-11 items-center text-sm text-accent-cyan underline-offset-4 hover:underline"
        >
          Open
        </Link>
      }
    >
      {notes === null ? (
        <Unavailable what="Notes" />
      ) : notes.length === 0 ? (
        <p className="text-sm text-text-secondary">No notes yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {notes.slice(0, SHOWN).map((note) => (
            <li key={note.id} className="flex items-center gap-2 py-1">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
                className="size-4 shrink-0 text-text-secondary"
              >
                <path d="M6 3h8l4 4v14H6V3Z" strokeLinejoin="round" />
                <path d="M14 3v4h4" strokeLinejoin="round" />
              </svg>
              <span className="truncate text-lg">{note.title}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
