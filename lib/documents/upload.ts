// Upload validation (M5-2, extended 2026-11-25 for OCR image uploads).
// Pure helpers; the route does the I/O.

// 4 MB (DATABASE.md §3.10). The upload passes through our route so the
// server can check the bytes first, and Vercel Functions refuse request
// bodies over 4.5 MB — so the limit sits below the platform's. Images
// share the PDF limit: OCR runs in the same 60 s route window, and a
// larger image would only be a larger OCR job.
export const MAX_PDF_BYTES = 4194304;
export const MAX_UPLOAD_BYTES = MAX_PDF_BYTES;
// Images need a 12-byte head to check (RIFF....WEBP); PDFs need 5.
export const UPLOAD_HEAD_BYTES = 12;

export type UploadFileKind = "pdf" | "png" | "jpeg" | "webp";

// The PDF magic header "%PDF-". Checked against the file's first bytes,
// never against its name: a renamed .txt file has no such header.
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
// PNG signature: 89 50 4e 47 0d 0a 1a 0a.
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// JPEG starts FF D8 FF (the fourth byte is the marker, E0/E1/DB/...).
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
// WebP is a RIFF container: bytes 0..3 "RIFF", bytes 8..11 "WEBP".
const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP_MARK = [0x57, 0x45, 0x42, 0x50];

function hasPrefix(head: Uint8Array, magic: number[]): boolean {
  return magic.every((byte, i) => head[i] === byte);
}

/** True when the first bytes are the PDF magic header. */
export function hasPdfMagic(head: Uint8Array): boolean {
  return hasPrefix(head, PDF_MAGIC);
}

/**
 * The file's kind from its magic bytes, never from its name or declared
 * MIME type — a renamed .txt file has no recognised header. Returns null
 * for anything that is not a PDF or a supported image.
 */
export function detectFileKind(head: Uint8Array): UploadFileKind | null {
  if (hasPrefix(head, PDF_MAGIC)) return "pdf";
  if (hasPrefix(head, PNG_MAGIC)) return "png";
  if (hasPrefix(head, JPEG_MAGIC)) return "jpeg";
  if (
    hasPrefix(head, WEBP_RIFF) &&
    hasPrefix(head.subarray(8), WEBP_MARK)
  ) {
    return "webp";
  }
  return null;
}

/** Storage extension for a kind (DATABASE.md §3.10 CHECK). */
export function fileExtension(kind: UploadFileKind): string {
  switch (kind) {
    case "pdf":
      return "pdf";
    case "png":
      return "png";
    case "jpeg":
      return "jpg";
    case "webp":
      return "webp";
  }
}

/** Content-Type stored with the file in the private bucket. */
export function fileContentType(kind: UploadFileKind): string {
  switch (kind) {
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
  }
}

const KNOWN_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "webp"];

/**
 * Title for the document row: the `title` form field when given, else the
 * uploaded filename without its extension. Always 1..255 characters,
 * matching the documents CHECK.
 */
export function documentTitle(fileName: string, titleField: unknown): string {
  if (typeof titleField === "string" && titleField.trim().length > 0) {
    return titleField.trim().slice(0, 255);
  }
  const lower = fileName.toLowerCase();
  let fromName = fileName;
  for (const ext of KNOWN_EXTENSIONS) {
    if (lower.endsWith(`.${ext}`)) {
      fromName = fileName.slice(0, fileName.length - ext.length - 1);
      break;
    }
  }
  const title = fromName.trim().slice(0, 255);
  return title.length > 0 ? title : "Untitled document";
}
