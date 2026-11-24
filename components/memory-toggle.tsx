// Memory toggle (M3-23, DESIGN.md §5.1). The global switch for
// memory injection, shared by the Memory screen and Settings. A null
// initial value means the setting could not be loaded: the toggle is
// replaced by "Unavailable", never a guessed state. Flipping it calls
// setMemoryEnabled (upsert on first change); a failed save reverts
// the switch and says so, so the screen never claims a state the
// database does not have.
"use client";

import { useState } from "react";
import { setMemoryEnabled } from "@/app/memory/actions";

export function MemoryToggle({
  initialEnabled,
  onChange,
}: {
  initialEnabled: boolean | null;
  onChange?: (enabled: boolean) => void;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (enabled === null) {
    return <p className="text-sm text-text-secondary">Memory setting: Unavailable.</p>;
  }

  async function flip() {
    const next = !enabled;
    setEnabled(next);
    setSaving(true);
    setError(null);
    const result = await setMemoryEnabled(next);
    setSaving(false);
    if (result.ok) {
      onChange?.(result.data);
    } else {
      // The database disagrees: put the switch back and say so.
      setEnabled(!next);
      setError("Could not save the setting. Nothing was changed.");
    }
  }

  return (
    <div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Memory"
          disabled={saving}
          onClick={() => void flip()}
          className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors duration-150 disabled:opacity-50 ${
            enabled ? "border-accent-cyan bg-accent-cyan/30" : "border-border-strong bg-surface-raised"
          }`}
        >
          <span
            aria-hidden="true"
            className={`absolute top-0.5 size-5.5 rounded-full bg-text-primary transition-all duration-150 ${
              enabled ? "left-6" : "left-0.5"
            }`}
          />
        </button>
        <span className="text-sm text-text-primary">
          {enabled ? "Memory on — FLASH remembers approved facts" : "Memory off — nothing is remembered or injected"}
        </span>
      </div>
      {saving ? (
        <p role="status" className="mt-2 text-sm text-text-secondary">
          Saving…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
