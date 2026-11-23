// PDF text extraction (M5-3). Wraps `unpdf` (a serverless build of Mozilla
// PDF.js) with a timeout race and page preparation for storage.
//
// Extraction is honest about failure: a parse error or a timeout throws
// ExtractionError and the caller records the document as 'failed' — never
// partial text, never a silent empty result. A page with no text (a scanned
// or image-only page) is an empty string, not an error; a document whose
// pages are all empty is 'no_text'.
import { extractText } from "unpdf";

// DATABASE.md §3.11: document_pages.content CHECK (20,000 characters).
export const MAX_PAGE_CHARS = 20000;
// The upload route's maxDuration is 60 s; extraction must finish inside it.
export const EXTRACTION_TIMEOUT_MS = 45000;

export type ExtractionFailureKind = "extraction_failed" | "extraction_timeout";

export class ExtractionError extends Error {
  readonly kind: ExtractionFailureKind;
  constructor(kind: ExtractionFailureKind, cause?: unknown) {
    super(
      `PDF extraction ${kind}${cause instanceof Error ? `: ${cause.message}` : ""}`,
    );
    this.name = "ExtractionError";
    this.kind = kind;
  }
}

/** Race a promise against a timeout; the timeout rejects with the given error. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  error: Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(error), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export interface ExtractedPages {
  pages: string[];
}

/**
 * Extract text page by page. Returns one string per page — empty when a
 * page has no text. Throws ExtractionError on a parse failure or when the
 * timeout fires.
 */
export async function extractDocumentPages(
  data: Uint8Array,
  options: { timeoutMs?: number } = {},
): Promise<ExtractedPages> {
  const timeoutMs = options.timeoutMs ?? EXTRACTION_TIMEOUT_MS;
  let result: { totalPages: number; text: string[] };
  try {
    result = await withTimeout(
      extractText(data, { mergePages: false }),
      timeoutMs,
      new ExtractionError("extraction_timeout"),
    );
  } catch (err) {
    if (err instanceof ExtractionError) throw err;
    throw new ExtractionError("extraction_failed", err);
  }
  return { pages: result.text };
}

export interface PreparedPages {
  pages: Array<{ page: number; text: string }>;
  truncated: boolean;
}

/**
 * Shape extracted pages for save_document_extraction: page numbers 1..n,
 * text cut to 20,000 characters per page. A cut is reported, never hidden
 * (DATABASE.md §3.11: the document's error_code records 'page_truncated').
 */
export function preparePages(pages: string[]): PreparedPages {
  let truncated = false;
  const prepared = pages.map((text, i) => {
    if (text.length > MAX_PAGE_CHARS) {
      truncated = true;
      return { page: i + 1, text: text.slice(0, MAX_PAGE_CHARS) };
    }
    return { page: i + 1, text };
  });
  return { pages: prepared, truncated };
}

/** True when no page carries any text (a scanned or image-only PDF). */
export function hasNoText(pages: string[]): boolean {
  return pages.every((page) => page.trim().length === 0);
}
