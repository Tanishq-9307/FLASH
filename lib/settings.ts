// Live configuration panel (Phase 2, 2026-11-25). The per-user app
// settings that live on the `settings` row in Supabase. A missing row
// means "defaults" — the app never has to create one at signup, and
// no row is written until the owner changes a setting.
//
// Only settings for features that exist are here. There is no theme
// setting because FLASH ships exactly one theme (Electric Cyan); no
// setting is invented for a feature that does not exist. And there is
// deliberately no field for any credential: secrets stay in
// environment variables only, and the update schema below rejects
// every key it does not know — including anything named like a key,
// token, secret, or password — so the panel can never be used to
// read or write one.
import { z } from "zod";

export interface AppSettings {
  memory_enabled: boolean;
  telegram_proactive_enabled: boolean;
  default_coding_mode: boolean;
  reduce_motion: boolean;
  show_usage_meter: boolean;
}

/** The settings a user with no row gets. */
export const DEFAULT_SETTINGS: AppSettings = {
  memory_enabled: true,
  telegram_proactive_enabled: true,
  default_coding_mode: false,
  reduce_motion: false,
  show_usage_meter: true,
};

/** The five keys the panel may change — nothing else. */
export const SETTINGS_KEYS = [
  "memory_enabled",
  "telegram_proactive_enabled",
  "default_coding_mode",
  "reduce_motion",
  "show_usage_meter",
] as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[number];

/**
 * A partial settings update, validated. Strict: any key outside the
 * five known settings — including `groq_api_key`, `api_key`,
 * `token`, `secret`, `password`, or any other spelling of a
 * credential — fails validation and nothing is written.
 */
export const settingsUpdateSchema = z
  .object({
    memory_enabled: z.boolean().optional(),
    telegram_proactive_enabled: z.boolean().optional(),
    default_coding_mode: z.boolean().optional(),
    reduce_motion: z.boolean().optional(),
    show_usage_meter: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "at least one setting must change",
  });

export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

/** Merge a possibly-missing row onto the defaults. */
export function settingsWithDefaults(
  row: Partial<AppSettings> | null | undefined,
): AppSettings {
  return { ...DEFAULT_SETTINGS, ...(row ?? {}) };
}

/**
 * The coding mode a chat request runs on. An explicit per-request
 * flag always wins; when the request carries none, the owner's
 * saved default decides. Coding mode itself (the larger model) is
 * unchanged by this — only where its default comes from.
 */
export function resolveCodingMode(
  requested: boolean | undefined,
  defaultCodingMode: boolean,
): boolean {
  return requested === undefined ? defaultCodingMode : requested;
}

/**
 * Apply the reduce-motion preference to the live document right
 * away — no reload, no navigation. The layout renders the same
 * attribute server-side on the next page load, so the two agree.
 */
export function setReduceMotion(doc: Document, on: boolean): void {
  doc.documentElement.dataset.reduceMotion = on ? "true" : "false";
}

export interface SettingDef {
  key: SettingsKey;
  label: string;
  description: string;
}

/** The panel's rows, in display order. */
export const SETTING_DEFS: SettingDef[] = [
  {
    key: "memory_enabled",
    label: "Memory",
    description:
      "FLASH remembers approved facts and uses them in chat. Off means nothing is remembered or injected.",
  },
  {
    key: "default_coding_mode",
    label: "Default model: coding",
    description:
      "New chats start with the larger coding model (gpt-oss-120b) instead of the standard model (llama-3.3-70b-versatile). The toggle in chat still overrides it for that session.",
  },
  {
    key: "telegram_proactive_enabled",
    label: "Proactive nudges",
    description:
      "FLASH may send Telegram nudges about overdue tasks and high usage. Quiet hours 23:00–07:00 IST always apply.",
  },
  {
    key: "reduce_motion",
    label: "Reduce motion",
    description:
      "Animations play as a single static frame. The system reduced-motion preference is honoured too.",
  },
  {
    key: "show_usage_meter",
    label: "Usage meter",
    description:
      "Show the Usage & Limits panel on the Overview. Off hides it until you turn it back on here.",
  },
];
