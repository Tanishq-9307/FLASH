// Settings panel (Phase 2, 2026-11-25). The live configuration
// screen: every app setting as a switch, applied immediately — no
// restart, no redeploy. A null initial value means the settings
// could not be loaded: the panel says "Unavailable", never a guessed
// state. Flipping a switch updates the screen at once and saves to
// Supabase; a failed save reverts the switch and says so, so the
// screen never claims a state the database does not have. Reduce
// motion also takes effect on the live document the moment it is
// flipped (the layout renders the same attribute server-side on the
// next page load). There is no field here for any credential —
// secrets stay in environment variables only.
"use client";

import { useState } from "react";
import { updateSettings } from "@/app/settings/actions";
import {
  SETTING_DEFS,
  setReduceMotion,
  type AppSettings,
  type SettingsKey,
} from "@/lib/settings";

function SettingSwitch({
  label,
  description,
  checked,
  onFlip,
  saving,
}: {
  label: string;
  description: string;
  checked: boolean;
  onFlip: () => void;
  saving: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-3 last:border-b-0">
      <div>
        <p className="text-sm font-medium text-text-primary">{label}</p>
        <p className="mt-1 text-sm text-text-secondary">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={saving}
        onClick={onFlip}
        className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors duration-150 disabled:opacity-50 ${
          checked
            ? "border-accent-cyan bg-accent-cyan/30"
            : "border-border-strong bg-surface-raised"
        }`}
      >
        <span
          aria-hidden="true"
          className={`absolute top-0.5 size-5.5 rounded-full bg-text-primary transition-all duration-150 ${
            checked ? "left-6" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

export function SettingsPanel({
  initial,
}: {
  initial: AppSettings | null;
}) {
  const [settings, setSettings] = useState<AppSettings | null>(initial);
  const [savingKey, setSavingKey] = useState<SettingsKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (settings === null) {
    return (
      <p className="text-sm text-text-secondary">
        Settings: Unavailable. Your saved settings could not be loaded.
      </p>
    );
  }

  async function flip(key: SettingsKey) {
    if (!settings) return;
    const next = !settings[key];
    const previous = settings;
    setSettings({ ...previous, [key]: next });
    setSavingKey(key);
    setError(null);
    // Reduce motion applies to the live page the moment it flips.
    if (key === "reduce_motion") setReduceMotion(document, next);
    const result = await updateSettings({ [key]: next });
    setSavingKey(null);
    if (result.ok) {
      setSettings(result.data);
    } else {
      // The database disagrees: put the switch back and say so.
      if (key === "reduce_motion") setReduceMotion(document, previous.reduce_motion);
      setSettings(previous);
      setError("Could not save the setting. Nothing was changed.");
    }
  }

  return (
    <div>
      {SETTING_DEFS.map((def) => (
        <SettingSwitch
          key={def.key}
          label={def.label}
          description={def.description}
          checked={settings[def.key]}
          saving={savingKey === def.key}
          onFlip={() => void flip(def.key)}
        />
      ))}
      {savingKey ? (
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
