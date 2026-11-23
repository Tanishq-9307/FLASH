import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// M0-6: every DESIGN.md Section 3 token is present in globals.css, and
// layout.tsx loads the three self-hosted fonts from DESIGN.md Section 4.
const TOKENS = [
  "#090d16",
  "#101624",
  "#172033",
  "#243049",
  "#5b6c92",
  "#eaf0fa",
  "#a3b0c6",
  "#8593ad",
  "#2dd4e8",
  "#a78bfa",
  "#34d399",
  "#fbbf24",
  "#f87171",
  "#60a5fa",
  "#04121a",
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
});
