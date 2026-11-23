// Upload route tests (M5-2): authenticated upload endpoint with size and
// magic-byte validation, owner-path storage, and generic errors. The
// user-scoped client is mocked, but its `documents` inserts run the real
// queries through `authenticated` with RLS against a fresh PGlite database,
// and the fake storage bucket records exactly what the route stored.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  callAs,
  createTestDb,
  createTestUser,
  deleteTestUser,
  setTestUser,
} from "./db/helpers";
import { corruptPdf, imageOnlyPdf, multiPagePdf } from "./fixtures/pdfs";

// Hoisted holders: vi.mock factories run before imports, so shared mutable
// state must live in vi.hoisted.
const testState = vi.hoisted(() => ({
  db: null as PGlite | null,
  user: null as { id: string } | null,
  files: new Map<string, { bytes: Uint8Array; contentType: string }>(),
  failUpload: false,
  failInsert: false,
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => {
    const { callAs: runAs } = await import("./db/helpers");
    // Minimal supabase-js query builder: only the methods the route uses
    // (insert/select/eq/order/single), executed as `authenticated` so RLS
    // applies exactly as it does for a real browser client.
    class MockBuilder {
      private op: "select" | "insert" = "select";
      private columns = "*";
      private selectAfterInsert = false;
      private insertValues: Record<string, unknown> | null = null;
      private filters: Array<{ col: string; value: unknown }> = [];
      private orderings: Array<{ col: string; ascending: boolean }> = [];
      private singleRow = false;

      constructor(private table: string) {}

      select(columns: string): this {
        if (this.op === "insert") this.selectAfterInsert = true;
        this.columns = columns;
        return this;
      }

      insert(values: Record<string, unknown>): this {
        this.op = "insert";
        this.insertValues = values;
        return this;
      }

      eq(col: string, value: unknown): this {
        this.filters.push({ col, value });
        return this;
      }

      order(col: string, opts?: { ascending?: boolean }): this {
        this.orderings.push({ col, ascending: opts?.ascending ?? true });
        return this;
      }

      single(): this {
        this.singleRow = true;
        return this;
      }

      then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
        onfulfilled?:
          | ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): Promise<TResult1 | TResult2> {
        return this.execute().then(onfulfilled, onrejected);
      }

      private async execute(): Promise<{ data: unknown; error: unknown }> {
        const db = testState.db!;
        if (
          this.op === "insert" &&
          this.table === "documents" &&
          testState.failInsert
        ) {
          return { data: null, error: { message: "insert failed" } };
        }
        const params: unknown[] = [];
        const where = this.filters.length
          ? " WHERE " +
            this.filters
              .map((f) => {
                params.push(f.value);
                return `"${f.col}" = $${params.length}`;
              })
              .join(" AND ")
          : "";
        const orderBy = this.orderings.length
          ? " ORDER BY " +
            this.orderings
              .map((o) => `"${o.col}" ${o.ascending ? "ASC" : "DESC"}`)
              .join(", ")
          : "";
        try {
          let rows: Record<string, unknown>[];
          if (this.op === "insert") {
            const keys = Object.keys(this.insertValues!);
            const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
            const returning = this.selectAfterInsert ? this.columns : "*";
            const r = await runAs<Record<string, unknown>>(
              db,
              "authenticated",
              `INSERT INTO ${this.table} (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${placeholders}) RETURNING ${returning}`,
              Object.values(this.insertValues!),
            );
            rows = r.rows;
            if (!this.selectAfterInsert) return { data: [], error: null };
          } else {
            const r = await runAs<Record<string, unknown>>(
              db,
              "authenticated",
              `SELECT ${this.columns} FROM ${this.table}${where}${orderBy}`,
              params,
            );
            rows = r.rows;
          }
          if (this.singleRow) {
            if (rows.length !== 1) {
              return {
                data: null,
                error: {
                  code: "PGRST116",
                  message: "JSON object requested, multiple (or no) rows returned",
                },
              };
            }
            return { data: rows[0], error: null };
          }
          return { data: rows, error: null };
        } catch (err) {
          return { data: null, error: { message: (err as Error).message } };
        }
      }
    }
    return {
      auth: {
        getUser: async () => ({
          data: { user: testState.user },
          error: testState.user ? null : new Error("no session"),
        }),
      },
      from: (table: string) => new MockBuilder(table),
      storage: {
        from: (bucket: string) => ({
          upload: async (
            path: string,
            file: Blob,
            opts?: { contentType?: string; upsert?: boolean },
          ) => {
            expect(bucket).toBe("documents");
            expect(opts?.upsert).toBe(false);
            if (testState.failUpload) {
              return { data: null, error: { message: "storage down" } };
            }
            const bytes = new Uint8Array(await file.arrayBuffer());
            testState.files.set(path, {
              bytes,
              contentType: opts?.contentType ?? file.type,
            });
            return { data: { path }, error: null };
          },
          remove: async (paths: string[]) => {
            for (const path of paths) testState.files.delete(path);
            return { data: [], error: null };
          },
        }),
      },
    };
  },
}));

// "server-only" throws when imported outside a React Server Component
// (M4-2): the admin module imports it, so it is mocked to a no-op here.
// The production guard is unchanged (Next.js enforces it).
vi.mock("server-only", () => ({}));

vi.mock("@/utils/supabase/admin", () => ({
  // The mocked admin client's rpc runs the real save_document_extraction
  // function against the fresh PGlite database, so the extraction outcome
  // is proven against real Postgres, not against the mock.
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const db = testState.db!;
      if (fn === "save_document_extraction") {
        const r = await db.query(
          "SELECT save_document_extraction($1, $2, $3, $4, $5)",
          [
            args.p_user_id,
            args.p_document_id,
            args.p_status,
            args.p_pages == null ? null : JSON.stringify(args.p_pages),
            args.p_error_code,
          ],
        );
        return { data: r.rows, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  }),
}));

import { POST, maxDuration } from "@/app/api/documents/upload/route";

function uploadRequest(form: FormData): Request {
  return new Request("http://localhost/api/documents/upload", {
    method: "POST",
    body: form,
  });
}

function pdfForm(
  bytes: Uint8Array,
  fileName = "report.pdf",
  title?: string,
): FormData {
  const form = new FormData();
  form.set(
    "file",
    new File([bytes as BlobPart], fileName, { type: "application/pdf" }),
  );
  if (title !== undefined) form.set("title", title);
  return form;
}

describe("POST /api/documents/upload", () => {
  it("exports maxDuration 60 (extraction runs in the same request)", () => {
    expect(maxDuration).toBe(60);
  });

  let db: PGlite;
  let userId: string;

  beforeAll(async () => {
    db = await createTestDb();
    testState.db = db;
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    userId = await createTestUser(db);
    await setTestUser(db, userId);
    testState.user = { id: userId };
  });

  afterEach(async () => {
    await deleteTestUser(db, userId);
    testState.user = null;
    testState.files.clear();
    testState.failUpload = false;
    testState.failInsert = false;
  });

  it("unauthenticated gets 401 and stores nothing", async () => {
    testState.user = null;
    const res = await POST(uploadRequest(pdfForm(multiPagePdf())));
    expect(res.status).toBe(401);
    expect(testState.files.size).toBe(0);
    const rows = await db.query("SELECT id FROM documents");
    expect(rows.rows).toHaveLength(0);
  });

  it("missing file gets 400 invalid-file", async () => {
    const res = await POST(uploadRequest(new FormData()));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid-file");
    expect(testState.files.size).toBe(0);
  });

  it("empty file gets 400 invalid-file", async () => {
    const res = await POST(uploadRequest(pdfForm(new Uint8Array(0))));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid-file");
    expect(testState.files.size).toBe(0);
  });

  it("non-PDF renamed .pdf is rejected by magic bytes", async () => {
    const notPdf = new TextEncoder().encode("hello, this is a text file");
    const res = await POST(uploadRequest(pdfForm(notPdf)));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid-file");
    expect(testState.files.size).toBe(0);
    const rows = await db.query("SELECT id FROM documents");
    expect(rows.rows).toHaveLength(0);
  });

  it("oversize file gets 413 too-large and is not stored", async () => {
    const big = new Uint8Array(4194305);
    big.set([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF- header, still too big
    const res = await POST(uploadRequest(pdfForm(big)));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("too-large");
    expect(testState.files.size).toBe(0);
  });

  it("valid PDF is stored under the owner path, extracted, and ready", async () => {
    const bytes = multiPagePdf();
    const res = await POST(uploadRequest(pdfForm(bytes, "quarterly-report.pdf")));
    expect(res.status).toBe(200);
    const body = await res.json();
    const doc = body.document as {
      id: string;
      title: string;
      size_bytes: number;
      status: string;
      page_count: number | null;
      error_code: string | null;
    };
    expect(doc.title).toBe("quarterly-report");
    expect(doc.size_bytes).toBe(bytes.length);
    expect(doc.status).toBe("ready");
    expect(doc.page_count).toBe(3);
    expect(doc.error_code).toBeNull();

    // The file is stored under <user_id>/<document_id>.pdf, bytes intact.
    const storedPath = `${userId}/${doc.id}.pdf`;
    const stored = testState.files.get(storedPath);
    expect(stored).toBeDefined();
    expect(stored!.contentType).toBe("application/pdf");
    expect(stored!.bytes).toEqual(bytes);
    expect(testState.files.size).toBe(1);

    // The row matches: owner, path, size, ready with 3 pages.
    const rows = await db.query<{
      user_id: string;
      title: string;
      storage_path: string;
      size_bytes: number;
      status: string;
      page_count: number;
    }>(
      "SELECT user_id, title, storage_path, size_bytes, status, page_count FROM documents WHERE id = $1",
      [doc.id],
    );
    expect(rows.rows).toEqual([
      {
        user_id: userId,
        title: "quarterly-report",
        storage_path: storedPath,
        size_bytes: bytes.length,
        status: "ready",
        page_count: 3,
      },
    ]);

    // The pages are stored with their page numbers and text.
    const pages = await db.query<{ page_number: number; content: string }>(
      "SELECT page_number, content FROM document_pages WHERE document_id = $1 ORDER BY page_number",
      [doc.id],
    );
    expect(pages.rows).toHaveLength(3);
    expect(pages.rows[0].content).toContain("budget is five thousand rupees");
    expect(pages.rows[1].content).toContain("Travel costs are capped");
    expect(pages.rows[2].content).toContain("deadline is the thirtieth");
  });

  it("image-only PDF uploads and settles as no_text with no pages", async () => {
    const bytes = imageOnlyPdf();
    const res = await POST(uploadRequest(pdfForm(bytes, "scan.pdf")));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.document.status).toBe("no_text");
    expect(body.document.page_count).toBeNull();
    expect(body.document.error_code).toBeNull();
    const rows = await db.query<{ status: string }>(
      "SELECT status FROM documents WHERE id = $1",
      [body.document.id],
    );
    expect(rows.rows).toEqual([{ status: "no_text" }]);
    const pages = await db.query(
      "SELECT page_number FROM document_pages WHERE document_id = $1",
      [body.document.id],
    );
    expect(pages.rows).toHaveLength(0);
  });

  it("corrupt PDF uploads and settles as failed, honestly", async () => {
    const bytes = corruptPdf();
    const res = await POST(uploadRequest(pdfForm(bytes, "broken.pdf")));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.document.status).toBe("failed");
    expect(body.document.error_code).toBe("extraction_failed");
    const rows = await db.query<{ status: string; error_code: string }>(
      "SELECT status, error_code FROM documents WHERE id = $1",
      [body.document.id],
    );
    expect(rows.rows).toEqual([{ status: "failed", error_code: "extraction_failed" }]);
    const pages = await db.query(
      "SELECT page_number FROM document_pages WHERE document_id = $1",
      [body.document.id],
    );
    expect(pages.rows).toHaveLength(0);
  });

  it("title form field wins over the filename", async () => {
    const res = await POST(
      uploadRequest(pdfForm(multiPagePdf(), "report.pdf", "My Notes")),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.document.title).toBe("My Notes");
  });

  it("upload failure gets a generic 500 and creates no row", async () => {
    testState.failUpload = true;
    const res = await POST(uploadRequest(pdfForm(multiPagePdf())));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("upload_failed");
    expect(testState.files.size).toBe(0);
    const rows = await db.query("SELECT id FROM documents");
    expect(rows.rows).toHaveLength(0);
  });

  it("row-insert failure removes the uploaded file and gets a generic 500", async () => {
    testState.failInsert = true;
    const res = await POST(uploadRequest(pdfForm(multiPagePdf())));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("document_create_failed");
    // Best-effort cleanup: no orphan file without a row.
    expect(testState.files.size).toBe(0);
    const rows = await db.query("SELECT id FROM documents");
    expect(rows.rows).toHaveLength(0);
  });
});
