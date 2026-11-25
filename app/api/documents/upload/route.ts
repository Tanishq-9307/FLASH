// POST /api/documents/upload (M5-2, extended 2026-11-25 for OCR image
// uploads).
//
// Order of operations:
// 1. Verify the session with getUser(). Unauthenticated → 401, and the
//    file is never read.
// 2. Validate the file: it must be a non-empty PDF or supported image
//    (PNG, JPEG, WebP) between 1 byte and 4 MB. The check is the magic
//    bytes, not the filename or the declared MIME type — a renamed .txt
//    file is rejected. Oversize → 413.
// 3. Store the file under the owner's path (<user_id>/<document_id>.<ext>)
//    in the private `documents` bucket, with the user-scoped client (the
//    bucket's owner-folder policies enforce the path).
// 4. Insert the document row with the user-scoped client (RLS: the row
//    must be the owner's, still 'processing', with no page count or error).
//    If the insert fails, the uploaded file is removed again so no orphan
//    file survives without a row.
// 5. Extract the text and record the outcome (M5-3, OCR 2026-11-25):
//    PDFs go through unpdf page by page; images go through tesseract.js
//    OCR as a single page (page 1). Either way the text lands in the
//    SAME document_pages rows via save_document_extraction, so an image
//    is searchable and citable on the same footing as a PDF. 'ready' with
//    the pages, 'no_text' when no text is found, 'failed' when extraction
//    throws or times out — recorded through save_document_extraction,
//    never by the client. If the save itself fails, the upload reports a
//    generic 500: the file and the row exist, but the upload did not
//    finish cleanly (the row stays 'processing' and the owner can delete
//    it from the Documents screen in M5-5).
// 6. Return the document with its settled status.
//
// Errors are generic: the caller learns the file was rejected, never why
// the server failed. Content is never executed or rendered server-side
// beyond extraction.
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  ExtractionError,
  extractDocumentPages,
  hasNoText,
  preparePages,
} from "@/lib/documents/extract";
import { OcrError, extractImageText } from "@/lib/documents/ocr";
import { embedDocumentPages } from "@/lib/vector-ingest";
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_HEAD_BYTES,
  detectFileKind,
  documentTitle,
  fileContentType,
  fileExtension,
} from "@/lib/documents/upload";

export const maxDuration = 60;

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid-file" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "invalid-file" }, { status: 400 });
  }
  if (file.size < 1) {
    return NextResponse.json({ error: "invalid-file" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "too-large" }, { status: 413 });
  }
  const head = new Uint8Array(await file.slice(0, UPLOAD_HEAD_BYTES).arrayBuffer());
  const kind = detectFileKind(head);
  if (kind === null) {
    return NextResponse.json({ error: "invalid-file" }, { status: 400 });
  }

  const title = documentTitle(
    file instanceof File ? file.name : `document.${fileExtension(kind)}`,
    form.get("title"),
  );
  const id = randomUUID();
  const storagePath = `${user.id}/${id}.${fileExtension(kind)}`;

  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(storagePath, file, {
      contentType: fileContentType(kind),
      upsert: false,
    });
  if (uploadError) {
    console.error("Document upload failed", uploadError);
    return NextResponse.json({ error: "upload_failed" }, { status: 500 });
  }

  const { error: insertError } = await supabase.from("documents").insert({
    id,
    title,
    storage_path: storagePath,
    size_bytes: file.size,
  });
  if (insertError) {
    // Best-effort cleanup: a file without a row would be unreachable.
    await supabase.storage.from("documents").remove([storagePath]);
    console.error("Document row insert failed", insertError);
    return NextResponse.json({ error: "document_create_failed" }, { status: 500 });
  }

  // Extract the text and record the outcome (M5-3, OCR 2026-11-25).
  // PDFs extract page by page; images OCR into a single page (page 1).
  // Both land in the same document_pages rows.
  const bytes = new Uint8Array(await file.arrayBuffer());
  let status: "ready" | "no_text" | "failed";
  let pages: Array<{ page: number; text: string }> | null = null;
  let errorCode: string | null = null;
  try {
    const extracted =
      kind === "pdf"
        ? (await extractDocumentPages(bytes)).pages
        : [(await extractImageText(bytes)).text];
    if (hasNoText(extracted)) {
      status = "no_text";
    } else {
      const prepared = preparePages(extracted);
      pages = prepared.pages;
      status = "ready";
      if (prepared.truncated) errorCode = "page_truncated";
    }
  } catch (err) {
    if (err instanceof OcrError) {
      status = "failed";
      errorCode =
        err.kind === "ocr_timeout"
          ? "extraction_timeout"
          : err.kind === "ocr_unavailable"
            ? "ocr_unavailable"
            : "extraction_failed";
    } else if (
      err instanceof ExtractionError &&
      err.kind === "extraction_timeout"
    ) {
      status = "failed";
      errorCode = "extraction_timeout";
    } else {
      status = "failed";
      errorCode = "extraction_failed";
    }
    console.error("Document extraction failed", err);
  }

  const admin = createAdminClient();
  const { error: saveError } = await admin.rpc("save_document_extraction", {
    p_user_id: user.id,
    p_document_id: id,
    p_status: status,
    p_pages: pages,
    p_error_code: errorCode,
  });
  if (saveError) {
    console.error("Document extraction save failed", saveError);
    return NextResponse.json({ error: "extraction_failed" }, { status: 500 });
  }

  // Embed the ready pages best-effort (vector RAG, 2026-11-25): the
  // document is saved and the upload succeeds either way — a missing
  // key or a provider failure just leaves the pages unembedded, and
  // the backfill script covers them later. Never fails the upload.
  if (status === "ready" && pages !== null) {
    try {
      await embedDocumentPages(admin, user.id, id, pages);
    } catch (err) {
      console.error("Document page embedding failed unexpectedly", err);
    }
  }

  return NextResponse.json({
    document: {
      id,
      title,
      file_type: kind,
      size_bytes: file.size,
      status,
      page_count: status === "ready" ? pages!.length : null,
      error_code: errorCode,
    },
  });
}
