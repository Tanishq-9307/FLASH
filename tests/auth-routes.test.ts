// M1-1: no sign-up path exists anywhere in the app (M1-0 decision).
// The login page exists; no signup/register route or link, and the auth
// actions never call signUp.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("M1-1: no sign-up path", () => {
  it("the login page exists", () => {
    expect(existsSync(join(root, "app/login/page.tsx"))).toBe(true);
  });

  it("no signup or register route exists", () => {
    const appFiles = readdirSync(join(root, "app"), { recursive: true }) as string[];
    const signupRoutes = appFiles.filter((f) => /sign[-_]?up|register/i.test(f));
    expect(signupRoutes).toEqual([]);
  });

  it("the login page has no sign-up link, button, or API call", () => {
    const text = read("app/login/page.tsx");
    // No anchor or button offering registration, and no signUp call.
    expect(text).not.toMatch(/<a[^>]*>/i);
    expect(text).not.toMatch(/signUp/);
    expect(text).not.toMatch(/>Sign up</i);
    expect(text).not.toMatch(/create account/i);
    expect(text).not.toMatch(/register/i);
  });

  it("the auth actions never call signUp", () => {
    const text = read("app/login/actions.ts");
    expect(text).not.toContain("signUp");
  });
});
