// Settings unit tests (Phase 2, 2026-11-25).
//
// Covers the pure rules: the update schema accepts exactly the five
// known settings and rejects every other key — including anything
// named like a credential — the defaults for a missing row, the
// coding-mode resolution (explicit flag wins, otherwise the saved
// default), and the live reduce-motion application on the document.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  resolveCodingMode,
  setReduceMotion,
  settingsUpdateSchema,
  settingsWithDefaults,
  SETTING_DEFS,
  SETTINGS_KEYS,
} from "@/lib/settings";

describe("settings schema", () => {
  it("accepts a partial update of known settings", () => {
    expect(settingsUpdateSchema.safeParse({ reduce_motion: true }).success).toBe(true);
    expect(
      settingsUpdateSchema.safeParse({
        memory_enabled: false,
        telegram_proactive_enabled: false,
        default_coding_mode: true,
        reduce_motion: true,
        show_usage_meter: false,
      }).success,
    ).toBe(true);
  });

  it("rejects an empty update — nothing to write", () => {
    expect(settingsUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("rejects non-boolean values", () => {
    expect(settingsUpdateSchema.safeParse({ reduce_motion: "yes" }).success).toBe(false);
    expect(settingsUpdateSchema.safeParse({ show_usage_meter: 1 }).success).toBe(false);
  });

  it("rejects every unknown key, including credential-named ones", () => {
    const forbidden = [
      { groq_api_key: "x" },
      { api_key: "x" },
      { openrouter_api_key: "x" },
      { tavily_api_key: "x" },
      { elevenlabs_api_key: "x" },
      { token: "x" },
      { telegram_bot_token: "x" },
      { secret: "x" },
      { supabase_secret_key: "x" },
      { password: "x" },
      { db_password: "x" },
      { theme: "dark" },
      { model: "gpt-oss-120b" },
    ];
    for (const patch of forbidden) {
      expect(
        settingsUpdateSchema.safeParse(patch).success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });

  it("the panel offers exactly the five known settings, and no other", () => {
    expect([...SETTINGS_KEYS].sort()).toEqual([
      "default_coding_mode",
      "memory_enabled",
      "reduce_motion",
      "show_usage_meter",
      "telegram_proactive_enabled",
    ]);
    expect(SETTING_DEFS.map((d) => d.key).sort()).toEqual([...SETTINGS_KEYS].sort());
    // No definition mentions a credential, ever.
    for (const def of SETTING_DEFS) {
      expect(`${def.label} ${def.description}`).not.toMatch(/key|token|secret|password/i);
    }
  });
});

describe("settings defaults", () => {
  it("a missing row means the defaults", () => {
    expect(settingsWithDefaults(null)).toEqual(DEFAULT_SETTINGS);
    expect(settingsWithDefaults(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({
      memory_enabled: true,
      telegram_proactive_enabled: true,
      default_coding_mode: false,
      reduce_motion: false,
      show_usage_meter: true,
    });
  });

  it("a partial row merges onto the defaults", () => {
    expect(settingsWithDefaults({ reduce_motion: true })).toEqual({
      ...DEFAULT_SETTINGS,
      reduce_motion: true,
    });
  });
});

describe("resolveCodingMode", () => {
  it("an explicit flag always wins over the saved default", () => {
    expect(resolveCodingMode(true, false)).toBe(true);
    expect(resolveCodingMode(false, true)).toBe(false);
  });

  it("an absent flag uses the saved default", () => {
    expect(resolveCodingMode(undefined, true)).toBe(true);
    expect(resolveCodingMode(undefined, false)).toBe(false);
  });
});

describe("setReduceMotion", () => {
  it("sets the document attribute immediately, both ways", () => {
    const doc = {
      documentElement: { dataset: {} as Record<string, string> },
    } as unknown as Document;
    setReduceMotion(doc, true);
    expect(doc.documentElement.dataset.reduceMotion).toBe("true");
    setReduceMotion(doc, false);
    expect(doc.documentElement.dataset.reduceMotion).toBe("false");
  });
});
