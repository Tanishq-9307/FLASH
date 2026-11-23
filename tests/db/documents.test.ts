// Documents schema tests (M5-1): documents + document_pages tables, RLS,
// private Storage bucket policies, and the service-role
// save_document_extraction function — all against a fresh PGlite database.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  callAs,
  createTestDb,
  createTestUser,
  deleteTestUser,
  setTestUser,
} from "./helpers";

async function insertDocument(
  db: PGlite,
  userId: string,
  overrides: { title?: string; sizeBytes?: number } = {},
): Promise<{ id: string; storagePath: string }> {
  const id = randomUUID();
  const storagePath = `${userId}/${id}.pdf`;
  await setTestUser(db, userId);
  await callAs(
    db,
    "authenticated",
    `INSERT INTO documents (id, title, storage_path, size_bytes)
     VALUES ($1, $2, $3, $4)`,
    [id, overrides.title ?? "Test doc", storagePath, overrides.sizeBytes ?? 1234],
  );
  return { id, storagePath };
}

async function saveExtraction(
  db: PGlite,
  userId: string,
  docId: string,
  status: string,
  pages: Array<{ page: number; text: string }> | null,
  errorCode: string | null,
): Promise<void> {
  await callAs(
    db,
    "service_role",
    "SELECT save_document_extraction($1, $2, $3, $4, $5)",
    [
      userId,
      docId,
      status,
      pages === null ? null : JSON.stringify(pages),
      errorCode,
    ],
  );
}

describe("documents schema (M5-1)", () => {
  let db: PGlite;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    db = await createTestDb();
    userA = await createTestUser(db);
    userB = await createTestUser(db);
  });

  afterAll(async () => {
    await deleteTestUser(db, userA);
    await deleteTestUser(db, userB);
    await db.close();
  });

  beforeEach(async () => {
    await setTestUser(db, userA);
  });

  it("catalog: RLS on both tables, the bucket, policies, index, and the function", async () => {
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
        WHERE relname IN ('documents', 'document_pages', 'objects')
        ORDER BY relname`,
    );
    expect(rls.rows).toEqual([
      { relname: "document_pages", relrowsecurity: true },
      { relname: "documents", relrowsecurity: true },
      { relname: "objects", relrowsecurity: true },
    ]);

    const policies = await db.query<{ schemaname: string; tablename: string; policyname: string; cmd: string }>(
      `SELECT schemaname, tablename, policyname, cmd FROM pg_policies
        WHERE (schemaname = 'public' AND tablename IN ('documents', 'document_pages'))
           OR (schemaname = 'storage' AND tablename = 'objects')
        ORDER BY schemaname, tablename, policyname`,
    );
    expect(policies.rows).toEqual([
      { schemaname: "public", tablename: "document_pages", policyname: "document_pages_owner_select", cmd: "SELECT" },
      { schemaname: "public", tablename: "documents", policyname: "documents_owner_delete", cmd: "DELETE" },
      { schemaname: "public", tablename: "documents", policyname: "documents_owner_insert", cmd: "INSERT" },
      { schemaname: "public", tablename: "documents", policyname: "documents_owner_select", cmd: "SELECT" },
      { schemaname: "storage", tablename: "objects", policyname: "documents_bucket_owner_delete", cmd: "DELETE" },
      { schemaname: "storage", tablename: "objects", policyname: "documents_bucket_owner_insert", cmd: "INSERT" },
      { schemaname: "storage", tablename: "objects", policyname: "documents_bucket_owner_select", cmd: "SELECT" },
    ]);

    const bucket = await db.query<{
      id: string;
      public: boolean;
      file_size_limit: number;
      allowed_mime_types: string[];
    }>(
      "SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'documents'",
    );
    expect(bucket.rows).toEqual([
      {
        id: "documents",
        public: false,
        file_size_limit: 4194304,
        allowed_mime_types: ["application/pdf"],
      },
    ]);

    const anonGrants = await db.query(
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE grantee = 'anon' AND table_name IN ('documents', 'document_pages')`,
    );
    expect(anonGrants.rows).toHaveLength(0);

    const index = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'document_pages' AND indexname = 'document_pages_search_idx'`,
    );
    expect(index.rows).toHaveLength(1);

    const fn = await db.query<{ prosecdef: boolean }>(
      "SELECT prosecdef FROM pg_proc WHERE proname = 'save_document_extraction'",
    );
    expect(fn.rows).toEqual([{ prosecdef: true }]);
  });

  it("A inserts a processing document; A reads it, B reads none, anon is denied", async () => {
    const doc = await insertDocument(db, userA);
    const asA = await callAs<{ id: string; status: string }>(
      db,
      "authenticated",
      "SELECT id, status FROM documents WHERE id = $1",
      [doc.id],
    );
    expect(asA.rows).toEqual([{ id: doc.id, status: "processing" }]);

    await setTestUser(db, userB);
    const asB = await callAs(
      db,
      "authenticated",
      "SELECT id FROM documents WHERE id = $1",
      [doc.id],
    );
    expect(asB.rows).toHaveLength(0);

    await expect(
      callAs(db, "anon", "SELECT id FROM documents"),
    ).rejects.toThrow(/permission denied/);
  });

  it("insert WITH CHECK refuses a ready status, a wrong path, another owner, and bad sizes", async () => {
    const id = randomUUID();
    // Status 'ready' at insert time.
    await expect(
      callAs(
        db,
        "authenticated",
        `INSERT INTO documents (id, title, storage_path, size_bytes, status)
         VALUES ($1, 'x', $2, 10, 'ready')`,
        [id, `${userA}/${id}.pdf`],
      ),
    ).rejects.toThrow(/row-level security/);
    // storage_path must pin the row to its own file.
    await expect(
      callAs(
        db,
        "authenticated",
        `INSERT INTO documents (id, title, storage_path, size_bytes)
         VALUES ($1, 'x', 'someone-else/file.pdf', 10)`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/check constraint/);
    // Another user's id.
    await expect(
      callAs(
        db,
        "authenticated",
        `INSERT INTO documents (id, user_id, title, storage_path, size_bytes)
         VALUES ($1, $2, 'x', $3, 10)`,
        [randomUUID(), userB, `${userB}/${randomUUID()}.pdf`],
      ),
    ).rejects.toThrow(/row-level security/);
    // size_bytes outside 1..4194304.
    for (const size of [0, 4194305]) {
      const badId = randomUUID();
      await expect(
        callAs(
          db,
          "authenticated",
          `INSERT INTO documents (id, title, storage_path, size_bytes)
           VALUES ($1, 'x', $2, $3)`,
          [badId, `${userA}/${badId}.pdf`, size],
        ),
      ).rejects.toThrow(/check constraint/);
    }
    // Empty title.
    const emptyId = randomUUID();
    await expect(
      callAs(
        db,
        "authenticated",
        `INSERT INTO documents (id, title, storage_path, size_bytes)
         VALUES ($1, '', $2, 10)`,
        [emptyId, `${userA}/${emptyId}.pdf`],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("no client UPDATE: A cannot change a document, but A can delete their own", async () => {
    const doc = await insertDocument(db, userA);
    await expect(
      callAs(
        db,
        "authenticated",
        "UPDATE documents SET title = 'renamed' WHERE id = $1",
        [doc.id],
      ),
    ).rejects.toThrow(/permission denied/);

    // B's delete matches no row (policy filters by owner); A's delete works.
    await setTestUser(db, userB);
    const asB = await callAs<{ id: string }>(
      db,
      "authenticated",
      "DELETE FROM documents WHERE id = $1 RETURNING id",
      [doc.id],
    );
    expect(asB.rows).toHaveLength(0);
    await setTestUser(db, userA);
    const asA = await callAs<{ id: string }>(
      db,
      "authenticated",
      "DELETE FROM documents WHERE id = $1 RETURNING id",
      [doc.id],
    );
    expect(asA.rows).toEqual([{ id: doc.id }]);
  });

  it("pages: no client writes at all; A reads only their own pages", async () => {
    const doc = await insertDocument(db, userA);
    await saveExtraction(db, userA, doc.id, "ready", [
      { page: 1, text: "The quarterly budget is five thousand rupees." },
    ], null);

    await expect(
      callAs(
        db,
        "authenticated",
        `INSERT INTO document_pages (document_id, user_id, page_number, content)
         VALUES ($1, $2, 2, 'forged')`,
        [doc.id, userA],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      callAs(
        db,
        "authenticated",
        "UPDATE document_pages SET content = 'forged' WHERE document_id = $1",
        [doc.id],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      callAs(
        db,
        "authenticated",
        "DELETE FROM document_pages WHERE document_id = $1",
        [doc.id],
      ),
    ).rejects.toThrow(/permission denied/);

    const asA = await callAs<{ page_number: number; content: string }>(
      db,
      "authenticated",
      "SELECT page_number, content FROM document_pages WHERE document_id = $1",
      [doc.id],
    );
    expect(asA.rows).toEqual([
      { page_number: 1, content: "The quarterly budget is five thousand rupees." },
    ]);
    await setTestUser(db, userB);
    const asB = await callAs(
      db,
      "authenticated",
      "SELECT page_number FROM document_pages WHERE document_id = $1",
      [doc.id],
    );
    expect(asB.rows).toHaveLength(0);
  });

  it("save_document_extraction: ready stores pages and sets the count", async () => {
    const doc = await insertDocument(db, userA);
    await saveExtraction(db, userA, doc.id, "ready", [
      { page: 1, text: "The quarterly budget is five thousand rupees." },
      { page: 2, text: "Travel costs are capped at one thousand." },
    ], null);
    const row = await db.query<{ status: string; page_count: number; error_code: string | null }>(
      "SELECT status, page_count, error_code FROM documents WHERE id = $1",
      [doc.id],
    );
    expect(row.rows).toEqual([{ status: "ready", page_count: 2, error_code: null }]);
    const pages = await db.query<{ page_number: number }>(
      "SELECT page_number FROM document_pages WHERE document_id = $1 ORDER BY page_number",
      [doc.id],
    );
    expect(pages.rows).toEqual([{ page_number: 1 }, { page_number: 2 }]);

    // Full-text search finds only the matching page.
    const hits = await db.query<{ page_number: number }>(
      `SELECT page_number FROM document_pages
        WHERE document_id = $1 AND search @@ plainto_tsquery('english', 'budget')
        ORDER BY page_number`,
      [doc.id],
    );
    expect(hits.rows).toEqual([{ page_number: 1 }]);

    // A second extraction is refused: the document is no longer processing.
    await expect(
      saveExtraction(db, userA, doc.id, "ready", [{ page: 1, text: "again" }], null),
    ).rejects.toThrow(/not found or not processing/);
  });

  it("save_document_extraction: no_text and failed store no pages", async () => {
    const noText = await insertDocument(db, userA);
    await saveExtraction(db, userA, noText.id, "no_text", null, null);
    const noTextRow = await db.query<{ status: string; page_count: number | null }>(
      "SELECT status, page_count FROM documents WHERE id = $1",
      [noText.id],
    );
    expect(noTextRow.rows).toEqual([{ status: "no_text", page_count: null }]);

    const failed = await insertDocument(db, userA);
    await saveExtraction(db, userA, failed.id, "failed", null, "extraction_failed");
    const failedRow = await db.query<{ status: string; error_code: string }>(
      "SELECT status, error_code FROM documents WHERE id = $1",
      [failed.id],
    );
    expect(failedRow.rows).toEqual([{ status: "failed", error_code: "extraction_failed" }]);

    const pages = await db.query(
      "SELECT page_number FROM document_pages WHERE document_id IN ($1, $2)",
      [noText.id, failed.id],
    );
    expect(pages.rows).toHaveLength(0);
  });

  it("save_document_extraction: refuses the wrong owner, clients, and bad input", async () => {
    const doc = await insertDocument(db, userA);
    await expect(
      saveExtraction(db, userB, doc.id, "ready", [{ page: 1, text: "x" }], null),
    ).rejects.toThrow(/not found or not processing/);
    await expect(
      callAs(
        db,
        "authenticated",
        "SELECT save_document_extraction($1, $2, 'ready', '[]'::jsonb, NULL)",
        [userA, doc.id],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      callAs(
        db,
        "anon",
        "SELECT save_document_extraction($1, $2, 'ready', '[]'::jsonb, NULL)",
        [userA, doc.id],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      saveExtraction(db, userA, doc.id, "done", null, null),
    ).rejects.toThrow(/invalid status/);
    await expect(
      saveExtraction(db, userA, doc.id, "ready", [
        { page: 2, text: "second" },
        { page: 1, text: "first" },
      ], null),
    ).rejects.toThrow(/1\.\.n in order/);
    await expect(
      saveExtraction(db, userA, doc.id, "ready", [{ page: 1, text: "x".repeat(20001) }], null),
    ).rejects.toThrow(/too long/);
    await expect(
      saveExtraction(db, userA, doc.id, "ready", [], null),
    ).rejects.toThrow(/1\.\.300 pages/);
    // The document is still processing after all the refusals.
    const row = await db.query<{ status: string }>(
      "SELECT status FROM documents WHERE id = $1",
      [doc.id],
    );
    expect(row.rows).toEqual([{ status: "processing" }]);
  });

  it("storage objects: owner-folder policies for files", async () => {
    const ownPath = `${userA}/file.pdf`;
    const otherPath = `${userB}/file.pdf`;
    await callAs(
      db,
      "authenticated",
      "INSERT INTO storage.objects (bucket_id, name) VALUES ('documents', $1)",
      [ownPath],
    );
    const asA = await callAs<{ name: string }>(
      db,
      "authenticated",
      "SELECT name FROM storage.objects WHERE bucket_id = 'documents'",
    );
    expect(asA.rows).toEqual([{ name: ownPath }]);

    await setTestUser(db, userB);
    const asB = await callAs(
      db,
      "authenticated",
      "SELECT name FROM storage.objects WHERE bucket_id = 'documents'",
    );
    expect(asB.rows).toHaveLength(0);
    // B cannot upload into A's folder, or into another bucket.
    await expect(
      callAs(
        db,
        "authenticated",
        "INSERT INTO storage.objects (bucket_id, name) VALUES ('documents', $1)",
        [ownPath],
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      callAs(
        db,
        "authenticated",
        "INSERT INTO storage.objects (bucket_id, name) VALUES ('other', $1)",
        [otherPath],
      ),
    ).rejects.toThrow(/row-level security/);
    // B's delete of A's file matches no row.
    const deletedByB = await callAs<{ id: string }>(
      db,
      "authenticated",
      "DELETE FROM storage.objects WHERE name = $1 RETURNING id",
      [ownPath],
    );
    expect(deletedByB.rows).toHaveLength(0);
    // No UPDATE policy at all: the update silently affects nothing, so a
    // file cannot be swapped after its text was extracted.
    await setTestUser(db, userA);
    const swapped = await callAs<{ name: string }>(
      db,
      "authenticated",
      "UPDATE storage.objects SET name = $1 WHERE name = $2 RETURNING name",
      [`${userA}/swapped.pdf`, ownPath],
    );
    expect(swapped.rows).toHaveLength(0);
    const stillThere = await callAs<{ name: string }>(
      db,
      "authenticated",
      "SELECT name FROM storage.objects WHERE name = $1",
      [ownPath],
    );
    expect(stillThere.rows).toEqual([{ name: ownPath }]);
    // A's delete works.
    const deletedByA = await callAs<{ id: string }>(
      db,
      "authenticated",
      "DELETE FROM storage.objects WHERE name = $1 RETURNING id",
      [ownPath],
    );
    expect(deletedByA.rows).toHaveLength(1);
    await expect(
      callAs(db, "anon", "SELECT name FROM storage.objects"),
    ).rejects.toThrow(/permission denied/);
  });

  it("storage.foldername splits the object path", async () => {
    const r = await db.query<{ parts: string[] }>(
      "SELECT storage.foldername('550e8400-e29b-41d4-a716-446655440000/doc.pdf') AS parts",
    );
    expect(r.rows).toEqual([
      { parts: ["550e8400-e29b-41d4-a716-446655440000", "doc.pdf"] },
    ]);
  });

  it("deleting a document cascades its pages", async () => {
    const doc = await insertDocument(db, userA);
    await saveExtraction(db, userA, doc.id, "ready", [
      { page: 1, text: "page one" },
      { page: 2, text: "page two" },
    ], null);
    await callAs(
      db,
      "authenticated",
      "DELETE FROM documents WHERE id = $1",
      [doc.id],
    );
    const pages = await db.query(
      "SELECT page_number FROM document_pages WHERE document_id = $1",
      [doc.id],
    );
    expect(pages.rows).toHaveLength(0);
  });

  it("the migration applies cleanly a second time", async () => {
    const sql = readFileSync(
      join(process.cwd(), "supabase", "migrations", "20261123132112_documents_storage.sql"),
      "utf8",
    );
    await db.exec(sql);
    const bucket = await db.query(
      "SELECT id FROM storage.buckets WHERE id = 'documents'",
    );
    expect(bucket.rows).toHaveLength(1);
  });
});
