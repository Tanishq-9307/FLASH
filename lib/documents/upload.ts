// PDF upload validation (M5-2). Pure helpers; the route does the I/O.

// 4 MB (DATABASE.md §3.10). The upload passes through our route so the
// server can check the bytes first, and Vercel Functions refuse request
// bodies over 4.5 MB — so the limit sits below the platform's.
export const MAX_PDF_BYTES = 4194304;

// The PDF magic header "%PDF-". Checked against the file's first bytes,
// never against its name: a renamed .txt file has no such header.
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

/** True when the first bytes are the PDF magic header. */
export function hasPdfMagic(head: Uint8Array): boolean {
  return PDF_MAGIC.every((byte, i) => head[i] === byte);
}

/**
 * Title for the document row: the `title` form field when given, else the
 * uploaded filename without its .pdf extension. Always 1..255 characters,
 * matching the documents CHECK.
 */
export function documentTitle(fileName: string, titleField: unknown): string {
  if (typeof titleField === "string" && titleField.trim().length > 0) {
    return titleField.trim().slice(0, 255);
  }
  const fromName = fileName.replace(/\.pdf$/i, "").trim().slice(0, 255);
  return fromName.length > 0 ? fromName : "Untitled document";
}
