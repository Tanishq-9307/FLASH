// Vector memory RAG — database tests (2026-11-25).
// The migration applies on PGlite in full (no pgvector needed — the
// design is real[] + pure-SQL cosine similarity, so nothing here is a
// skip or a stand-in): columns, CHECKs, cosine correctness on known
// vectors, match ranking + threshold, save_* ownership + dimension
// rules, and the service-role-only grants.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import {
  callAs,
  createTestDb,
  createTestUser,
  deleteTestUser,
} from "./helpers";

/** A 512-dim vector with the given positions set (deterministic test
 * doubles — clearly mocked, never presented as real embeddings). */
function vec(entries: Record<number, number>): number[] {
  const v = new Array<number>(512).fill(0);
  for (const [i, value] of Object.entries(entries)) v[Number(i)] = value;
  return v;
}

/** Postgres array literal for a JS number array. */
function literal(v: number[]): string {
  return `{${v.join(",")}}`;
}

async function cosine(
  db: PGlite,
  a: number[] | null,
  b: number[] | null,
): Promise<number | null> {
  const r = await db.query<{ cosine_similarity: number | null }>(
    "SELECT cosine_similarity($1::real[], $2::real[]) AS cosine_similarity",
    [a === null ? null : literal(a), b === null ? null : literal(b)],
  );
  return r.rows[0].cosine_similarity;
}

describe("vector memory RAG migration", () => {
  let db: PGlite;
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    db = await createTestDb();
    userId = await createTestUser(db);
    otherUserId = await createTestUser(db);
  });

  afterAll(async () => {
    await deleteTestUser(db, userId);
    await deleteTestUser(db, otherUserId);
    await db.close();
  });

  async function seedMemory(
    ownerId: string,
    fact: string,
    embedding: number[] | null,
    createdAt?: string,
  ): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO memories (id, user_id, fact, embedding${createdAt ? ", created_at" : ""})
       VALUES ($1, $2, $3, $4::real[]${createdAt ? ", $5" : ""})`,
      createdAt
        ? [id, ownerId, fact, embedding === null ? null : literal(embedding), createdAt]
        : [id, ownerId, fact, embedding === null ? null : literal(embedding)],
    );
    return id;
  }

  async function seedDocument(
    ownerId: string,
    title: string,
    status: string,
  ): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO documents (id, user_id, title, storage_path, size_bytes, status)
       VALUES ($1, $2, $3, $4, 100, $5)`,
      [id, ownerId, title, `${ownerId}/${id}.pdf`, status],
    );
    return id;
  }

  async function seedPage(
    documentId: string,
    ownerId: string,
    pageNumber: number,
    content: string,
    embedding: number[] | null,
  ): Promise<void> {
    await db.query(
      `INSERT INTO document_pages (document_id, user_id, page_number, content, embedding)
       VALUES ($1, $2, $3, $4, $5::real[])`,
      [
        documentId,
        ownerId,
        pageNumber,
        content,
        embedding === null ? null : literal(embedding),
      ],
    );
  }

  describe("cosine_similarity", () => {
    it("identical vectors score 1", async () => {
      expect(await cosine(db, vec({ 0: 1 }), vec({ 0: 1 }))).toBeCloseTo(1, 10);
    });

    it("orthogonal vectors score 0", async () => {
      expect(await cosine(db, vec({ 0: 1 }), vec({ 1: 1 }))).toBeCloseTo(0, 10);
    });

    it("opposite vectors score -1", async () => {
      expect(await cosine(db, vec({ 0: 1 }), vec({ 0: -1 }))).toBeCloseTo(-1, 10);
    });

    it("a 3-4-5 triangle scores 0.6 against the x axis", async () => {
      expect(await cosine(db, vec({ 0: 3, 1: 4 }), vec({ 0: 1 }))).toBeCloseTo(
        0.6,
        10,
      );
    });

    it("NULL input, mismatched lengths, and zero vectors score NULL", async () => {
      expect(await cosine(db, null, vec({ 0: 1 }))).toBeNull();
      expect(await cosine(db, vec({ 0: 1 }), null)).toBeNull();
      expect(await cosine(db, [1, 2], [1, 2, 3])).toBeNull();
      expect(await cosine(db, vec({}), vec({ 0: 1 }))).toBeNull();
    });
  });

  describe("embedding columns and CHECKs", () => {
    it("new rows start unembedded (NULL)", async () => {
      const id = await seedMemory(userId, "Unembedded fact.", null);
      const r = await db.query<{ embedding: number[] | null }>(
        "SELECT embedding FROM memories WHERE id = $1",
        [id],
      );
      expect(r.rows[0].embedding).toBeNull();
    });

    it("a wrong-dimension embedding is refused by the CHECK", async () => {
      await expect(
        db.query(
          "UPDATE memories SET embedding = $1::real[] WHERE user_id = $2",
          [literal([1, 2, 3]), userId],
        ),
      ).rejects.toThrow();
    });

    it("a 512-dim embedding is accepted", async () => {
      // Dimension 5, not 0: the match tests below query [1,0,…], and
      // a seed on dimension 0 here would pollute their results.
      const id = await seedMemory(userId, "Embedded fact.", vec({ 5: 1 }));
      const r = await db.query<{ embedding: number[] }>(
        "SELECT embedding FROM memories WHERE id = $1",
        [id],
      );
      expect(r.rows[0].embedding).toHaveLength(512);
      expect(r.rows[0].embedding[5]).toBeCloseTo(1, 6);
    });
  });

  describe("match_memories", () => {
    it("returns the most similar first and drops below-threshold rows", async () => {
      const owner = userId;
      await seedMemory(owner, "Prefers morning runs.", vec({ 0: 1 }));
      await seedMemory(owner, "Prefers evening swims.", vec({ 1: 1 }));
      await seedMemory(owner, "Runs and swims both.", vec({ 0: 0.7071067811865476, 1: 0.7071067811865476 }));
      await seedMemory(owner, "Never embedded.", null);
      const r = await db.query<{ fact: string; similarity: number }>(
        "SELECT * FROM match_memories($1, $2::real[], 0.5, 5)",
        [owner, literal(vec({ 0: 1 }))],
      );
      expect(r.rows.map((row) => row.fact)).toEqual([
        "Prefers morning runs.",
        "Runs and swims both.",
      ]);
      expect(r.rows[0].similarity).toBeCloseTo(1, 6);
      expect(r.rows[1].similarity).toBeCloseTo(0.7071, 4);
    });

    it("a higher threshold narrows the results", async () => {
      const r = await db.query<{ fact: string }>(
        "SELECT * FROM match_memories($1, $2::real[], 0.9, 5)",
        [userId, literal(vec({ 0: 1 }))],
      );
      expect(r.rows.map((row) => row.fact)).toEqual(["Prefers morning runs."]);
    });

    it("match_count caps the results", async () => {
      const r = await db.query<{ fact: string }>(
        "SELECT * FROM match_memories($1, $2::real[], 0.5, 1)",
        [userId, literal(vec({ 0: 1 }))],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].fact).toBe("Prefers morning runs.");
    });

    it("another user's memories never match", async () => {
      await seedMemory(otherUserId, "Other user's runs.", vec({ 0: 1 }));
      const r = await db.query<{ fact: string }>(
        "SELECT * FROM match_memories($1, $2::real[], 0.5, 5)",
        [userId, literal(vec({ 0: 1 }))],
      );
      expect(r.rows.map((row) => row.fact)).not.toContain("Other user's runs.");
    });
  });

  describe("match_document_pages", () => {
    it("returns pages across ready documents with titles, best first", async () => {
      const docA = await seedDocument(userId, "Running Guide", "ready");
      const docB = await seedDocument(userId, "Swimming Guide", "ready");
      const docDraft = await seedDocument(userId, "Draft Notes", "processing");
      await seedPage(docA, userId, 1, "Morning runs build endurance.", vec({ 0: 1 }));
      await seedPage(docA, userId, 2, "Evening swims cool you down.", vec({ 1: 1 }));
      await seedPage(docB, userId, 1, "Run before breakfast.", vec({ 0: 0.9, 1: 0.43588989435406733 }));
      await seedPage(docDraft, userId, 1, "Draft about runs.", vec({ 0: 1 }));
      const r = await db.query<{
        document_title: string;
        page_number: number;
        content: string;
        similarity: number;
      }>(
        "SELECT * FROM match_document_pages($1, $2::real[], 0.5, 5)",
        [userId, literal(vec({ 0: 1 }))],
      );
      // The processing document's identical page is excluded; the
      // orthogonal swim page is below threshold.
      expect(
        r.rows.map((row) => `${row.document_title} p.${row.page_number}`),
      ).toEqual(["Running Guide p.1", "Swimming Guide p.1"]);
      expect(r.rows[0].similarity).toBeCloseTo(1, 6);
      expect(r.rows[0].content).toContain("Morning runs");
    });

    it("another user's pages never match", async () => {
      const doc = await seedDocument(otherUserId, "Other Doc", "ready");
      await seedPage(doc, otherUserId, 1, "Other user's runs.", vec({ 0: 1 }));
      const r = await db.query<{ document_title: string }>(
        "SELECT * FROM match_document_pages($1, $2::real[], 0.5, 5)",
        [userId, literal(vec({ 0: 1 }))],
      );
      expect(r.rows.map((row) => row.document_title)).not.toContain("Other Doc");
    });
  });

  describe("save_memory_embedding", () => {
    it("stores a 512-dim vector on the owner's memory", async () => {
      const id = await seedMemory(userId, "Save me.", null);
      await db.query("SELECT save_memory_embedding($1, $2, $3::real[])", [
        userId,
        id,
        literal(vec({ 2: 1 })),
      ]);
      const r = await db.query<{ embedding: number[] }>(
        "SELECT embedding FROM memories WHERE id = $1",
        [id],
      );
      expect(r.rows[0].embedding[2]).toBeCloseTo(1, 6);
    });

    it("refuses a wrong-dimension vector", async () => {
      const id = await seedMemory(userId, "Save me not.", null);
      await expect(
        db.query("SELECT save_memory_embedding($1, $2, $3::real[])", [
          userId,
          id,
          literal([1, 2, 3]),
        ]),
      ).rejects.toThrow("512 numbers");
    });

    it("refuses another user's memory", async () => {
      const id = await seedMemory(otherUserId, "Not yours.", null);
      await expect(
        db.query("SELECT save_memory_embedding($1, $2, $3::real[])", [
          userId,
          id,
          literal(vec({ 0: 1 })),
        ]),
      ).rejects.toThrow("not found");
    });
  });

  describe("save_document_page_embedding", () => {
    it("stores a vector on the owner's page and refuses a missing page", async () => {
      const doc = await seedDocument(userId, "Embed Me", "ready");
      await seedPage(doc, userId, 1, "Page one.", null);
      await db.query(
        "SELECT save_document_page_embedding($1, $2, $3, $4::real[])",
        [userId, doc, 1, literal(vec({ 3: 1 }))],
      );
      const r = await db.query<{ embedding: number[] }>(
        "SELECT embedding FROM document_pages WHERE document_id = $1",
        [doc],
      );
      expect(r.rows[0].embedding[3]).toBeCloseTo(1, 6);
      await expect(
        db.query(
          "SELECT save_document_page_embedding($1, $2, $3, $4::real[])",
          [userId, doc, 99, literal(vec({ 0: 1 }))],
        ),
      ).rejects.toThrow("page not found");
    });
  });

  describe("grants", () => {
    it("anon and authenticated cannot execute the match functions", async () => {
      for (const role of ["anon", "authenticated"] as const) {
        await expect(
          callAs(
            db,
            role,
            "SELECT * FROM match_memories($1, $2::real[], 0.5, 5)",
            [userId, literal(vec({ 0: 1 }))],
          ),
        ).rejects.toThrow("permission denied");
      }
    });

    it("service_role can execute the match functions", async () => {
      const r = await callAs<{ fact: string }>(
        db,
        "service_role",
        "SELECT * FROM match_memories($1, $2::real[], 0.5, 5)",
        [userId, literal(vec({ 0: 1 }))],
      );
      expect(r.rows.length).toBeGreaterThan(0);
    });
  });
});
