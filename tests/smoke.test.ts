import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

describe("M0-3: agent rules and skills", () => {
  it("package name is flash", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name: string;
    };
    expect(pkg.name).toBe("flash");
  });

  it("CLAUDE.md exists at the repo root", () => {
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(true);
    const text = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(text).toContain("FLASH");
    expect(text).not.toContain("JARVIS");
  });

  it("all five skills exist with name and description frontmatter", () => {
    const skills = [
      "new-task-session",
      "add-migration",
      "add-tool",
      "security-review",
      "milestone-gate",
    ];
    for (const skill of skills) {
      const path = join(root, ".claude", "skills", skill, "SKILL.md");
      expect(existsSync(path), `missing ${skill}`).toBe(true);
      const text = readFileSync(path, "utf8");
      const match = text.match(/^---\nname: (\S+)\ndescription: (.+)\n---/);
      expect(match, `${skill} frontmatter`).not.toBeNull();
      expect(match?.[1]).toBe(skill);
      expect((match?.[2] ?? "").length).toBeGreaterThan(10);
    }
  });

  it(".env.example holds placeholders only, no secret values", () => {
    const text = readFileSync(join(root, ".env.example"), "utf8");
    expect(text).not.toMatch(/sb_secret_/);
    expect(text).not.toMatch(/AIza[0-9A-Za-z_-]{10,}/);
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+/);
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const value = trimmed.split("=")[1] ?? "";
      expect(value.trim(), `non-empty value in ${trimmed}`).toBe("");
    }
  });
});
