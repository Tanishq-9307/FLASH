// Backfill script tests (vector memory RAG, 2026-11-25).
// The script itself is never run against a database here: the
// batching helper is unit-tested by import, and the env guard is
// proven by running the script with no keys and watching it refuse.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { chunkArray } from "../scripts/backfill-embeddings.mjs";

describe("backfill-embeddings.mjs", () => {
  it("chunks rows into batches of at most 128", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkArray([], 128)).toEqual([]);
    expect(chunkArray([1], 128)).toEqual([[1]]);
  });

  it("refuses to run without all three keys (never touches a database)", () => {
    const script = join(process.cwd(), "scripts", "backfill-embeddings.mjs");
    const env = { ...process.env };
    delete env.NEXT_PUBLIC_SUPABASE_URL;
    delete env.SUPABASE_SECRET_KEY;
    delete env.VOYAGE_API_KEY;
    const run = spawnSync("node", [script], { env, encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("must all be set");
  });
});
