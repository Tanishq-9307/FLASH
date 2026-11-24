// Memory screen (M3-23, DESIGN.md §5.1, PRD.md §5.3). Props-driven:
// the stored memories, the global switch, and the M3-0 privacy
// warning. Edit and delete go through the Server Actions; a row
// changes only after the server confirms it (DESIGN.md §9, rule 2).
// A null memories prop means the load failed: "Unavailable", never an
// empty list pretending there are no memories.
"use client";

import { useState } from "react";
import { deleteMemory, updateMemory } from "@/app/memory/actions";
import { MAX_MEMORY_FACT, MEMORY_PRIVACY_WARNING, type Memory } from "@/lib/memories";
import { MemoryToggle } from "./memory-toggle";

function MemoryRow({
  memory,
  onUpdated,
  onDeleted,
}: {
  memory: Memory;
  onUpdated: (row: Memory) => void;
  onDeleted: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory.fact);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    const result = await updateMemory(memory.id, draft);
    setBusy(false);
    if (result.ok) {
      onUpdated(result.data);
      setEditing(false);
    } else if (result.error === "invalid") {
      setError(`Facts need 1 to ${MAX_MEMORY_FACT.toLocaleString()} characters.`);
    } else {
      setError("Could not save. Nothing was changed.");
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    const result = await deleteMemory(memory.id);
    setBusy(false);
    if (result.ok) {
      onDeleted(memory.id);
    } else {
      setError("Could not delete. Nothing was changed.");
      setConfirming(false);
    }
  }

  return (
    <li className="rounded-md border border-border bg-surface p-3">
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor={`edit-${memory.id}`} className="sr-only">
            Edit memory
          </label>
          <textarea
            id={`edit-${memory.id}`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            maxLength={MAX_MEMORY_FACT}
            className="min-h-11 w-full rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary"
          />
          <p className="mt-1 font-mono text-xs text-text-muted">
            {draft.trim().length.toLocaleString()} / {MAX_MEMORY_FACT.toLocaleString()} characters
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="submit"
              disabled={busy || draft.trim().length === 0}
              className="flex min-h-11 items-center rounded-md bg-accent-cyan px-4 text-sm font-semibold text-on-accent disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(memory.fact);
                setEditing(false);
                setError(null);
              }}
              className="flex min-h-11 items-center rounded-md border border-border-strong px-4 text-sm text-text-primary"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="text-sm whitespace-pre-wrap text-text-primary">{memory.fact}</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditing(true)}
              className="flex min-h-11 items-center rounded-md border border-border-strong px-3 text-sm text-text-primary"
            >
              Edit
            </button>
            {confirming ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove()}
                  className="flex min-h-11 items-center rounded-md border border-danger px-3 text-sm text-danger"
                >
                  Confirm delete
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                  className="flex min-h-11 items-center rounded-md border border-border-strong px-3 text-sm text-text-primary"
                >
                  Keep it
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(true)}
                className="flex min-h-11 items-center rounded-md border border-border-strong px-3 text-sm text-text-primary"
              >
                Delete
              </button>
            )}
          </div>
        </>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}

export function MemoryScreen({
  initialMemories,
  memoryEnabled,
}: {
  initialMemories: Memory[] | null;
  memoryEnabled: boolean | null;
}) {
  const [memories, setMemories] = useState<Memory[] | null>(initialMemories);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <h1 className="font-display text-2xl font-semibold">Memory</h1>
      <p className="mt-1 text-sm text-text-secondary">
        Facts FLASH remembers about you. A fact is only ever saved after you approve it.
      </p>

      <div role="note" className="mt-4 rounded-md border border-warning/50 bg-surface-raised p-3">
        <p className="text-sm font-semibold text-warning">Privacy warning</p>
        <p className="mt-1 text-sm text-text-primary">{MEMORY_PRIVACY_WARNING}</p>
      </div>

      <section aria-label="Memory setting" className="mt-4 rounded-md border border-border bg-surface p-3">
        <MemoryToggle initialEnabled={memoryEnabled} />
        <p className="mt-2 text-sm text-text-secondary">
          When memory is off, FLASH injects nothing from past memories into the chat — the model
          is told nothing about them.
        </p>
      </section>

      {memories === null ? (
        <p role="alert" className="mt-6 text-sm text-text-secondary">
          Memories are Unavailable. The list could not be loaded.
        </p>
      ) : memories.length === 0 ? (
        <p className="mt-6 text-sm text-text-secondary">
          No memories yet. Ask FLASH to remember something and approve it.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {memories.map((memory) => (
            <MemoryRow
              key={memory.id}
              memory={memory}
              onUpdated={(row) =>
                setMemories((all) => (all ?? []).map((x) => (x.id === row.id ? row : x)))
              }
              onDeleted={(id) =>
                setMemories((all) => (all ?? []).filter((x) => x.id !== id))
              }
            />
          ))}
        </ul>
      )}
    </main>
  );
}
