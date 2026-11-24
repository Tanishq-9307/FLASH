import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// M0-6, re-themed 2026-11-24 (Electric Cyan, owner decision): every
// DESIGN.md Section 3 token is present in globals.css, and layout.tsx
// loads the three self-hosted fonts from DESIGN.md Section 4. The old
// palette (#090d16, #2dd4e8, violet #a78bfa) is gone; the orb now uses the
// cyan family only (--color-orb-*).
const TOKENS = [
  "#020a14",
  "#0a1c2e",
  "#0f2a44",
  "#14324d",
  "#3d7ab0",
  "#eaf6ff",
  "#9fc3d8",
  "#759db8",
  "#00e5ff",
  "#00b0ff",
  "#7df9ff",
  "#00ffc8",
  "#34d399",
  "#fbbf24",
  "#f87171",
  "#60a5fa",
  "#04121a",
];

const OLD_TOKENS = ["#090d16", "#2dd4e8", "#a78bfa"];

// WCAG relative luminance, computed the same way the ratios in
// PROGRESS.md were produced.
function luminance(hex: string): number {
  const channel = (i: number): number => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(fg: string, bg: string): number {
  const hi = Math.max(luminance(fg), luminance(bg));
  const lo = Math.min(luminance(fg), luminance(bg));
  return (hi + 0.05) / (lo + 0.05);
}

const BACKGROUNDS = ["#020a14", "#0a1c2e", "#0f2a44"];
const TEXT_COLORS = [
  "#eaf6ff",
  "#9fc3d8",
  "#759db8",
  "#00e5ff",
  "#00b0ff",
  "#7df9ff",
  "#00ffc8",
  "#34d399",
  "#fbbf24",
  "#f87171",
  "#60a5fa",
];

describe("M0-6: design tokens and fonts", () => {
  it("globals.css contains every Section 3 token", () => {
    const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
    for (const token of TOKENS) {
      expect(css.toLowerCase()).toContain(token);
    }
    expect(css).toContain(".flash-frame");
    expect(css).toContain(".panel-title");
  });

  it("globals.css contains none of the superseded palette", () => {
    const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
    for (const token of OLD_TOKENS) {
      expect(css.toLowerCase()).not.toContain(token);
    }
    expect(css).not.toContain("accent-violet");
  });

  it("layout.tsx loads Barlow, Rajdhani and JetBrains Mono via next/font", () => {
    const layout = readFileSync(
      join(process.cwd(), "app", "layout.tsx"),
      "utf8",
    );
    expect(layout).toContain('from "next/font/google"');
    expect(layout).toContain("Barlow");
    expect(layout).toContain("Rajdhani");
    expect(layout).toContain("JetBrains_Mono");
    expect(layout).not.toContain("Geist");
  });

  it("every text colour meets AA 4.5:1 on every surface", () => {
    for (const fg of TEXT_COLORS) {
      for (const bg of BACKGROUNDS) {
        expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("on-accent text meets AA on accent-cyan, border-strong and focus ring meet 3:1", () => {
    expect(contrast("#04121a", "#00e5ff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#3d7ab0", "#020a14")).toBeGreaterThanOrEqual(3);
    expect(contrast("#3d7ab0", "#0a1c2e")).toBeGreaterThanOrEqual(3);
    expect(contrast("#00e5ff", "#020a14")).toBeGreaterThanOrEqual(3);
  });
});
