// POST /api/documents/upload (M5-2): secure PDF upload.
//
// Order of operations:
// 1. Verify the session with getUser(). Unauthenticated → 401, and the
//    file is never read.
// 2. Validate the file: it must be a non-empty PDF between 1 byte and 4 MB.
//    The check is the %PDF- magic bytes, not the filename or the declared
//    MIME type — a renamed .txt file is rejected. Oversize → 413.
// 3. Store the file under the owner's path (<user_id>/<document_id>.pdf)
//    in the private `documents` bucket, with the user-scoped client (the
//    bucket's owner-folder policies enforce the path).
// 4. Insert the document row with the user-scoped client (RLS: the row
//    must be the owner's, still 'processing', with no page count or error).
//    If the insert fails, the uploaded file is removed again so no orphan
//    file survives without a row.
// 5. Return the document with status 'processing'. Extraction (M5-3) runs
//    next and moves the row to 'ready', 'no_text' or 'failed' through
//    save_document_extraction — the row is never 'ready' before extraction
//    has actually run.
//
// Errors are generic: the caller learns the file was rejected, never why
// the server failed. Content is never executed or rendered server-side
// beyond extraction.
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createClient } from "@/utils/supabase/server";
import {
  MAX_PDF_BYTES,
  documentTitle,
  hasPdfMagic,
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
  if (file.size > MAX_PDF_BYTES) {
    return NextResponse.json({ error: "too-large" }, { status: 413 });
  }
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (!hasPdfMagic(head)) {
    return NextResponse.json({ error: "invalid-file" }, { status: 400 });
  }

  const title = documentTitle(
    file instanceof File ? file.name : "document.pdf",
    form.get("title"),
  );
  const id = randomUUID();
  const storagePath = `${user.id}/${id}.pdf`;

  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(storagePath, file, {
      contentType: "application/pdf",
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

  return NextResponse.json({
    document: {
      id,
      title,
      size_bytes: file.size,
      status: "processing",
      page_count: null,
      error_code: null,
    },
  });
}
