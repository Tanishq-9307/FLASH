// Vector ingestion tests (vector memory RAG, 2026-11-25).
// The provider and the database are both faked: a deterministic
// document embedder and a fake admin rpc recording the save_* calls.
// No network and no key. The save_* functions themselves are proven
// against real Postgres in tests/db/vector-memory.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import {
  chunkTexts,
  embedDocumentPages,
  embedMemory,
  embedNewMemoryFromApproval,
} from "@/lib/vector-ingest";

const USER = "00000000-0000-4000-8000-000000000001";
const MEMORY_ID = "00000000-0000-4000-8000-000000000042";
const DOC_ID = "00000000-0000-4000-8000-000000000043";

function testVector(position: number): number[] {
  const v = new Array<number>(512).fill(0);
  v[position] = 1;
  return v;
}

/** Fake embedder: one deterministic vector per text, usage counted. */
function fakeEmbedder(vectors?: number[][]) {
  const calls: string[][] = [];
  const embed = vi.fn(async (texts: string[]) => {
    calls.push(texts);
    return {
      embeddings:
        vectors ?? texts.map((_, i) => testVector(i % 512)),
      usage: { totalTokens: texts.length * 3 },
    };
  });
  return { embed, calls };
}

function fakeAdmin(failRpc?: string) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (failRpc === fn) {
      return { data: null, error: { message: "db down" } };
    }
    return { data: [], error: null };
  });
  return {
    admin: { rpc } as unknown as SupabaseClient<Database>,
    rpc,
    rpcCalls,
  };
}

describe("chunkTexts", () => {
  it("splits into batches of the given size", () => {
    expect(chunkTexts([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7],
    ]);
    expect(chunkTexts([], 3)).toEqual([]);
    expect(chunkTexts([1, 2], 5)).toEqual([[1, 2]]);
  });
});

describe("embedMemory", () => {

  beforeEach(() => {
    vi.stubEnv("VOYAGE_API_KEY", "test-voyage-key");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("embeds the fact and saves the vector", async () => {
    const { admin, rpcCalls } = fakeAdmin();
    const { embed, calls } = fakeEmbedder([testVector(0)]);
    const status = await embedMemory(admin, USER, MEMORY_ID, "Prefers morning runs.", {
      embed,
    });
    expect(status).toBe("embedded");
    expect(calls).toEqual([["Prefers morning runs."]]);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("save_memory_embedding");
    expect(rpcCalls[0].args).toEqual({
      p_user_id: USER,
      p_memory_id: MEMORY_ID,
      p_embedding: testVector(0),
    });
  });

  it("no key means unavailable, with no provider or database call", async () => {
    vi.stubEnv("VOYAGE_API_KEY", "");
    const { admin, rpc } = fakeAdmin();
    const { embed } = fakeEmbedder();
    expect(
      await embedMemory(admin, USER, MEMORY_ID, "Prefers morning runs.", {
        embed,
      }),
    ).toBe("unavailable");
    expect(embed).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an empty fact is unavailable", async () => {
    const { admin, rpc } = fakeAdmin();
    const { embed } = fakeEmbedder();
    expect(
      await embedMemory(admin, USER, MEMORY_ID, "   ", { embed }),
    ).toBe("unavailable");
    expect(embed).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a provider failure is failed, never a throw", async () => {
    const { admin, rpc } = fakeAdmin();
    const embed = vi.fn(async () => {
      throw new Error("provider down");
    });
    expect(
      await embedMemory(admin, USER, MEMORY_ID, "Prefers morning runs.", {
        embed,
      }),
    ).toBe("failed");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a wrong-dimension vector from the provider is failed, never saved", async () => {
    const { admin, rpc } = fakeAdmin();
    const { embed } = fakeEmbedder([[1, 2, 3]]);
    expect(
      await embedMemory(admin, USER, MEMORY_ID, "Prefers morning runs.", {
        embed,
      }),
    ).toBe("failed");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a database failure is failed, never a throw", async () => {
    const { admin } = fakeAdmin("save_memory_embedding");
    const { embed } = fakeEmbedder([testVector(0)]);
    expect(
      await embedMemory(admin, USER, MEMORY_ID, "Prefers morning runs.", {
        embed,
      }),
    ).toBe("failed");
  });
});

describe("embedNewMemoryFromApproval", () => {

  beforeEach(() => {
    vi.stubEnv("VOYAGE_API_KEY", "test-voyage-key");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function adminWithMemory(fact: string | null) {
    const { admin, rpc, rpcCalls } = fakeAdmin();
    const from = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(async () =>
              fact === null
                ? { data: null, error: { message: "no rows" } }
                : { data: { fact }, error: null },
            ),
          })),
        })),
      })),
    }));
    (admin as unknown as Record<string, unknown>).from = from;
    return { admin, rpc, rpcCalls, from };
  }

  it("reads the fact back, embeds it, and saves the vector", async () => {
    const { admin, rpcCalls, from } = adminWithMemory("Prefers morning runs.");
    const { embed } = fakeEmbedder([testVector(0)]);
    const status = await embedNewMemoryFromApproval(admin, USER, MEMORY_ID, {
      embed,
    });
    expect(status).toBe("embedded");
    expect(from).toHaveBeenCalledWith("memories");
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("save_memory_embedding");
  });

  it("no key means unavailable, with no database read at all", async () => {
    vi.stubEnv("VOYAGE_API_KEY", "");
    const { admin, rpc, from } = adminWithMemory("Prefers morning runs.");
    const { embed } = fakeEmbedder();
    expect(
      await embedNewMemoryFromApproval(admin, USER, MEMORY_ID, { embed }),
    ).toBe("unavailable");
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it("an unreadable memory is failed, never a throw", async () => {
    const { admin } = adminWithMemory(null);
    const { embed } = fakeEmbedder();
    expect(
      await embedNewMemoryFromApproval(admin, USER, MEMORY_ID, { embed }),
    ).toBe("failed");
    expect(embed).not.toHaveBeenCalled();
  });
});

describe("embedDocumentPages", () => {

  beforeEach(() => {
    vi.stubEnv("VOYAGE_API_KEY", "test-voyage-key");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("embeds every page with text and saves one vector per page", async () => {
    const { admin, rpcCalls } = fakeAdmin();
    const { embed, calls } = fakeEmbedder([testVector(0), testVector(1)]);
    const status = await embedDocumentPages(
      admin,
      USER,
      DOC_ID,
      [
        { page: 1, text: "Page one." },
        { page: 2, text: "Page two." },
      ],
      { embed },
    );
    expect(status).toBe("embedded");
    expect(calls).toEqual([["Page one.", "Page two."]]);
    expect(rpcCalls.map((c) => c.fn)).toEqual([
      "save_document_page_embedding",
      "save_document_page_embedding",
    ]);
    expect(rpcCalls[0].args).toEqual({
      p_user_id: USER,
      p_document_id: DOC_ID,
      p_page_number: 1,
      p_embedding: testVector(0),
    });
    expect(rpcCalls[1].args.p_page_number).toBe(2);
  });

  it("skips pages with no text (nothing to embed)", async () => {
    const { admin, rpcCalls } = fakeAdmin();
    const { embed, calls } = fakeEmbedder([testVector(0)]);
    const status = await embedDocumentPages(
      admin,
      USER,
      DOC_ID,
      [
        { page: 1, text: "   " },
        { page: 2, text: "Page two." },
      ],
      { embed },
    );
    expect(status).toBe("embedded");
    expect(calls).toEqual([["Page two."]]);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].args.p_page_number).toBe(2);
  });

  it("no key means unavailable, with no provider or database call", async () => {
    vi.stubEnv("VOYAGE_API_KEY", "");
    const { admin, rpc } = fakeAdmin();
    const { embed } = fakeEmbedder();
    expect(
      await embedDocumentPages(admin, USER, DOC_ID, [{ page: 1, text: "x" }], {
        embed,
      }),
    ).toBe("unavailable");
    expect(embed).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a provider failure is failed, never a throw", async () => {
    const { admin, rpc } = fakeAdmin();
    const embed = vi.fn(async () => {
      throw new Error("provider down");
    });
    expect(
      await embedDocumentPages(admin, USER, DOC_ID, [{ page: 1, text: "x" }], {
        embed,
      }),
    ).toBe("failed");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("one page's save failure does not block the other page", async () => {
    const { admin, rpcCalls } = fakeAdmin();
    // Fail only the first page's save: the mock fails by call order.
    let call = 0;
    (admin.rpc as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        call += 1;
        if (call === 1) return { data: null, error: { message: "db down" } };
        return { data: [], error: null };
      },
    );
    const { embed } = fakeEmbedder([testVector(0), testVector(1)]);
    const status = await embedDocumentPages(
      admin,
      USER,
      DOC_ID,
      [
        { page: 1, text: "Page one." },
        { page: 2, text: "Page two." },
      ],
      { embed },
    );
    expect(status).toBe("embedded");
    expect(rpcCalls).toHaveLength(2);
  });
});
