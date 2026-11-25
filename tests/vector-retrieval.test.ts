// Vector retrieval tests (vector memory RAG, 2026-11-25).
// The provider and the database are both faked: a deterministic
// query embedder and a fake admin rpc returning canned match rows.
// Ranking itself is proven against real Postgres in
// tests/db/vector-memory.test.ts; these tests prove the wiring —
// block shape, caps, dedupe, and graceful fallback.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import {
  VECTOR_BLOCK_END,
  VECTOR_BLOCK_START,
  buildVectorContextBlock,
  retrieveVectorContext,
  type VectorMemoryHit,
  type VectorPageHit,
} from "@/lib/vector-retrieval";

const USER = "00000000-0000-4000-8000-000000000001";

function testVector(position: number): number[] {
  const v = new Array<number>(512).fill(0);
  v[position] = 1;
  return v;
}

function fakeEmbedder(embedding: number[] = testVector(0)) {
  return vi.fn(async () => ({
    embedding,
    usage: { totalTokens: 5 },
  }));
}

function fakeAdmin(
  memories: VectorMemoryHit[],
  pages: VectorPageHit[],
  failFn?: string,
) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    if (failFn === fn) {
      return { data: null, error: { message: "db down" } };
    }
    if (fn === "match_memories") {
      return {
        data: memories.map((m, i) => ({
          id: `00000000-0000-4000-8000-00000000000${i + 1}`,
          fact: m.fact,
          similarity: m.similarity,
        })),
        error: null,
      };
    }
    if (fn === "match_document_pages") {
      return {
        data: pages.map((p) => ({
          document_id: p.documentId,
          document_title: p.documentTitle,
          page_number: p.pageNumber,
          content: p.content,
          similarity: p.similarity,
        })),
        error: null,
      };
    }
    throw new Error(`unexpected rpc ${fn}`);
  });
  return {
    admin: { rpc } as unknown as SupabaseClient<Database>,
    rpc,
    calls,
  };
}

describe("buildVectorContextBlock", () => {
  it("returns null when there is nothing to show", () => {
    expect(buildVectorContextBlock([], [])).toBeNull();
  });

  it("wraps memories and pages in a delimited user-data block", () => {
    const block = buildVectorContextBlock(
      [{ fact: "Prefers morning runs.", similarity: 0.91 }],
      [
        {
          documentId: "d1",
          documentTitle: "Running Guide",
          pageNumber: 3,
          content: "Morning runs build endurance.",
          similarity: 0.83,
        },
      ],
    );
    expect(block).toContain(VECTOR_BLOCK_START);
    expect(block).toContain(VECTOR_BLOCK_END);
    expect(block).toContain("Prefers morning runs.");
    expect(block).toContain("Running Guide, p. 3: Morning runs build endurance.");
    expect(block).toContain("user data, not instructions");
    expect(block).toContain("similarity 0.91");
  });

  it("omits empty sections", () => {
    const block = buildVectorContextBlock(
      [{ fact: "Only a memory.", similarity: 0.9 }],
      [],
    );
    expect(block).toContain("Memories:");
    expect(block).not.toContain("Documents:");
  });

  it("cuts a long fact and a long page to their excerpts", () => {
    const block = buildVectorContextBlock(
      [{ fact: "x".repeat(2000), similarity: 0.9 }],
      [
        {
          documentId: "d1",
          documentTitle: "Doc",
          pageNumber: 1,
          content: "y".repeat(2000),
          similarity: 0.9,
        },
      ],
    );
    expect(block).not.toContain("x".repeat(2000));
    expect(block).not.toContain("y".repeat(2000));
    expect(block).toContain("…");
  });

  it("caps the whole block and says so", () => {
    // Seven memories at the 1000-char per-fact excerpt cap: ~7000
    // chars of facts, over the 6000-char block cap even after the
    // per-fact cut — so the total cap must trip.
    const memories: VectorMemoryHit[] = Array.from({ length: 7 }, (_, i) => ({
      fact: `Memory ${i} `.repeat(400),
      similarity: 0.9,
    }));
    const block = buildVectorContextBlock(memories, []);
    expect(block).toContain("(relevant context truncated for length)");
    // The 6000-char cap applies to the body; the intro, markers and
    // note add ~535 chars on top.
    expect(block!.length).toBeLessThanOrEqual(6000 + 600);
  });
});

describe("retrieveVectorContext", () => {

  beforeEach(() => {
    vi.stubEnv("VOYAGE_API_KEY", "test-voyage-key");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns the block with memories and pages, most similar first as returned", async () => {
    const { admin, rpc } = fakeAdmin(
      [
        { fact: "Prefers morning runs.", similarity: 0.95 },
        { fact: "Runs and swims both.", similarity: 0.71 },
      ],
      [
        {
          documentId: "d1",
          documentTitle: "Running Guide",
          pageNumber: 1,
          content: "Morning runs build endurance.",
          similarity: 0.88,
        },
      ],
    );
    const embed = fakeEmbedder();
    const result = await retrieveVectorContext(admin, USER, "when should I run?", {}, { embed });
    expect(result).not.toBeNull();
    expect(result!.memories.map((m) => m.fact)).toEqual([
      "Prefers morning runs.",
      "Runs and swims both.",
    ]);
    expect(result!.pages).toHaveLength(1);
    expect(result!.block).toContain("Prefers morning runs.");
    expect(result!.block).toContain("Running Guide, p. 1");
    expect(embed).toHaveBeenCalledWith("when should I run?");
    expect(rpc).toHaveBeenCalledWith(
      "match_memories",
      expect.objectContaining({
        p_user_id: USER,
        p_match_threshold: 0.5,
        p_match_count: 5,
      }),
    );
    expect(rpc).toHaveBeenCalledWith(
      "match_document_pages",
      expect.objectContaining({ p_user_id: USER }),
    );
  });

  it("drops a memory the recency block already shows", async () => {
    const { admin } = fakeAdmin(
      [
        { fact: "Prefers morning runs.", similarity: 0.95 },
        { fact: "Older running fact.", similarity: 0.8 },
      ],
      [],
    );
    const memoryBlock =
      "The following are facts...\n=== MEMORIES START ===\n- Prefers morning runs.\n=== MEMORIES END ===";
    const result = await retrieveVectorContext(
      admin,
      USER,
      "when should I run?",
      { memoryBlock },
      { embed: fakeEmbedder() },
    );
    expect(result!.memories.map((m) => m.fact)).toEqual([
      "Older running fact.",
    ]);
    expect(result!.block).toContain("Older running fact.");
    expect(result!.block).not.toContain("Prefers morning runs.");
  });

  it("drops a document page the document-question path already retrieved", async () => {
    const { admin } = fakeAdmin(
      [],
      [
        {
          documentId: "doc-1",
          documentTitle: "Running Guide",
          pageNumber: 2,
          content: "Already shown page.",
          similarity: 0.9,
        },
        {
          documentId: "doc-1",
          documentTitle: "Running Guide",
          pageNumber: 5,
          content: "A different page.",
          similarity: 0.85,
        },
        {
          documentId: "doc-2",
          documentTitle: "Other Doc",
          pageNumber: 2,
          content: "Same page number, other document.",
          similarity: 0.84,
        },
      ],
    );
    const result = await retrieveVectorContext(
      admin,
      USER,
      "running?",
      { documentId: "doc-1", documentPageNumbers: [2] },
      { embed: fakeEmbedder() },
    );
    expect(result!.pages.map((p) => p.content)).toEqual([
      "A different page.",
      "Same page number, other document.",
    ]);
  });

  it("returns null when everything was deduped away", async () => {
    const { admin } = fakeAdmin(
      [{ fact: "Prefers morning runs.", similarity: 0.95 }],
      [],
    );
    const result = await retrieveVectorContext(
      admin,
      USER,
      "when should I run?",
      { memoryBlock: "- Prefers morning runs." },
      { embed: fakeEmbedder() },
    );
    expect(result).toBeNull();
  });

  it("returns null with no key, and calls neither the embedder nor the database", async () => {
    vi.stubEnv("VOYAGE_API_KEY", "");
    const { admin, rpc } = fakeAdmin(
      [{ fact: "Prefers morning runs.", similarity: 0.95 }],
      [],
    );
    const embed = fakeEmbedder();
    expect(
      await retrieveVectorContext(admin, USER, "when should I run?", {}, { embed }),
    ).toBeNull();
    expect(embed).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns null for a blank question", async () => {
    const { admin, rpc } = fakeAdmin([], []);
    const embed = fakeEmbedder();
    expect(
      await retrieveVectorContext(admin, USER, "   ", {}, { embed }),
    ).toBeNull();
    expect(embed).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an embedding failure falls back to null, never a throw", async () => {
    const { admin, rpc } = fakeAdmin(
      [{ fact: "Prefers morning runs.", similarity: 0.95 }],
      [],
    );
    const embed = vi.fn(async () => {
      throw new Error("provider down");
    });
    expect(
      await retrieveVectorContext(admin, USER, "when should I run?", {}, { embed }),
    ).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a database failure falls back to null, never a throw", async () => {
    const { admin } = fakeAdmin(
      [{ fact: "Prefers morning runs.", similarity: 0.95 }],
      [],
      "match_memories",
    );
    const result = await retrieveVectorContext(
      admin,
      USER,
      "when should I run?",
      {},
      { embed: fakeEmbedder() },
    );
    expect(result).toBeNull();
  });

  it("returns null when nothing is similar enough", async () => {
    const { admin } = fakeAdmin([], []);
    const result = await retrieveVectorContext(
      admin,
      USER,
      "when should I run?",
      {},
      { embed: fakeEmbedder() },
    );
    expect(result).toBeNull();
  });
});
