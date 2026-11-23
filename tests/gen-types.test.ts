import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const script = join(root, "scripts", "gen-types.mjs");

describe("gen:types", () => {
  it("writes a valid empty Database type with no migrations", () => {
    const dir = mkdtempSync(join(tmpdir(), "flash-gen-types-empty-"));
    const out = join(dir, "types.ts");
    try {
      execFileSync("node", [script, "--migrations", join(dir, "migrations"), "--out", out], {
        stdio: "pipe",
      });
      const text = readFileSync(out, "utf8");
      expect(text).toContain("export type Database = {");
      expect(text).toContain("export type Json =");
      expect(text).toContain("Tables: {");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits tables, enums, and functions from applied migrations", () => {
    const dir = mkdtempSync(join(tmpdir(), "flash-gen-types-"));
    const migDir = join(dir, "migrations");
    const out = join(dir, "types.ts");
    mkdirSync(migDir, { recursive: true });
    try {
      writeFileSync(
        join(migDir, "20260101000000_sample.sql"),
        `
        CREATE TYPE public.sample_status AS ENUM ('open', 'closed');
        CREATE TABLE public.sample_tasks (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
          title text NOT NULL,
          status public.sample_status NOT NULL DEFAULT 'open',
          score integer,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE OR REPLACE FUNCTION public.sample_count(p_user_id uuid)
        RETURNS integer LANGUAGE sql STABLE SET search_path = public, pg_temp
        AS $$ SELECT count(*)::integer FROM public.sample_tasks WHERE user_id = p_user_id $$;
        `,
      );
      execFileSync("node", [script, "--migrations", migDir, "--out", out], { stdio: "pipe" });
      const text = readFileSync(out, "utf8");
      expect(text).toContain("sample_tasks: {");
      expect(text).toContain("title: string");
      expect(text).toContain("score: number | null");
      expect(text).toContain("status: sample_status");
      expect(text).toContain('sample_status: "open" | "closed"');
      expect(text).toContain("sample_count: {");
      expect(text).toContain("p_user_id: string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails naming the migration when one is invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "flash-gen-types-bad-"));
    const migDir = join(dir, "migrations");
    mkdirSync(migDir, { recursive: true });
    try {
      writeFileSync(join(migDir, "20260101000000_bad.sql"), `CREATE TABLE nope (`);
      expect(() =>
        execFileSync("node", [script, "--migrations", migDir, "--out", join(dir, "types.ts")], {
          stdio: "pipe",
        }),
      ).toThrow(/20260101000000_bad\.sql failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
