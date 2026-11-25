// OCR text extraction for image uploads (2026-11-25).
//
// Engine: tesseract.js 6.0.1 (Apache-2.0) with the English language data
// from @tesseract.js-data/eng 1.0.0 — no API key, no account, no network
// at runtime. In Node, tesseract.js loads its WASM core from the
// installed `tesseract.js-core` package and runs the worker in a
// worker_thread; only the language data defaults to a CDN fetch, and
// this module points it at the locally installed data instead
// (`node_modules/@tesseract.js-data/eng/4.0.0_best_int`, the same
// 2.9 MB integer model the library fetches by default — `4.0.0` is the
// 10.9 MB full model, kept as a fallback). The data file is read by
// tesseract.js through `fs`, so it is not statically traceable: the
// upload route's file-tracing config (next.config.ts) forces it into
// the serverless bundle, and `resolveLangPath` refuses to start a
// worker when the file is absent rather than failing halfway through.
// The worker is created with `cacheMethod: "none"`: by default
// tesseract.js writes the gunzipped language data to
// `<cwd>/eng.traineddata` on every cold worker — a stray 5 MB file in
// the repo locally, and a write to a read-only filesystem on Vercel.
// 'none' loads from langPath fresh every time instead.
//
// Extraction is honest about failure, like the PDF path in extract.ts:
// a corrupt image, a missing language file, or a timeout throws
// OcrError and the caller records the document as 'failed' — never
// partial text, never a guessed transcription. An image with no text
// (blank, or illegible to the engine) returns an empty string, not an
// error; the caller maps that to 'no_text', exactly like a scanned PDF.
//
// One tesseract.js trap, verified by a real run (PROGRESS.md): its
// default worker error handler re-throws worker errors on a bare
// nextTick, which CRASHES the process for a corrupt image. This module
// always passes its own `errorHandler`, so the recognize promise
// rejects cleanly instead and the worker stays usable.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createWorker } from "tesseract.js";
import { withTimeout } from "@/lib/documents/extract";

// The upload route's maxDuration is 60 s; OCR must finish inside it,
// same budget as PDF extraction.
export const OCR_TIMEOUT_MS = 45000;

/** Language recognised: English only. Other languages are out of scope. */
export const OCR_LANG = "eng";

/** The language-data directories, smallest first: `4.0.0_best_int` is
 * the 2.9 MB integer model tesseract.js fetches by default; `4.0.0` is
 * the 10.9 MB full model, used only if the small one is absent. */
export const OCR_LANG_DIRS = ["4.0.0_best_int", "4.0.0"] as const;

export type OcrFailureKind =
  | "ocr_failed"
  | "ocr_timeout"
  | "ocr_unavailable";

export class OcrError extends Error {
  readonly kind: OcrFailureKind;
  constructor(kind: OcrFailureKind, cause?: unknown) {
    super(
      `OCR ${kind}${cause instanceof Error ? `: ${cause.message}` : ""}`,
    );
    this.name = "OcrError";
    this.kind = kind;
  }
}

/** A function that turns image bytes into recognised text. Injectable
 * so tests can run without the engine; the default is the real
 * tesseract.js worker below. */
export type ImageRecognizer = (data: Uint8Array) => Promise<string>;

/**
 * Find the installed English language data: the first
 * `node_modules/@tesseract.js-data/eng/<dir>` that contains
 * `eng.traineddata.gz`. Returns null when no data is installed, so the
 * caller can fail honestly as 'ocr_unavailable' instead of starting a
 * worker that cannot load its language.
 */
export function resolveLangPath(cwd: string = process.cwd()): string | null {
  for (const dir of OCR_LANG_DIRS) {
    const langPath = join(cwd, "node_modules", "@tesseract.js-data", "eng", dir);
    if (existsSync(join(langPath, "eng.traineddata.gz"))) return langPath;
  }
  return null;
}

/**
 * One recognition with a fresh tesseract.js worker. The worker is
 * created per upload and terminated afterwards: a long-lived worker
 * would hold WASM memory between serverless invocations for no benefit,
 * and a fresh worker cannot carry state from a previous image.
 */
async function recognizeWithTesseract(
  data: Uint8Array,
  langPath: string,
): Promise<string> {
  const worker = await createWorker(OCR_LANG, undefined, {
    langPath,
    // Never use tesseract.js's on-disk cache: by default it writes the
    // gunzipped language data to `<cwd>/eng.traineddata` on every cold
    // worker — a stray 5 MB file in the repo locally, and a write to a
    // read-only filesystem on Vercel. 'none' loads from langPath fresh
    // every time instead (local disk, ~1 s worker start, verified).
    cacheMethod: "none",
    // See the header: without this, a corrupt image crashes the process.
    errorHandler: () => {},
  });
  try {
    // recognize() takes Buffer (its loader normalises to Uint8Array
    // internally); the route hands over a plain Uint8Array.
    const { data: result } = await worker.recognize(Buffer.from(data));
    return result.text;
  } finally {
    try {
      await worker.terminate();
    } catch {
      // The worker is already dead (e.g. the corrupt-image abort that
      // the errorHandler swallowed); nothing left to shut down.
    }
  }
}

/**
 * Extract the text of one image. Returns the raw recognised text —
 * empty when the image carries no readable text. Throws OcrError on a
 * recognition failure, when the language data is missing, or when the
 * timeout fires.
 */
export async function extractImageText(
  data: Uint8Array,
  options: {
    timeoutMs?: number;
    langPath?: string | null;
    recognize?: ImageRecognizer;
  } = {},
): Promise<{ text: string }> {
  const timeoutMs = options.timeoutMs ?? OCR_TIMEOUT_MS;
  const recognize =
    options.recognize ??
    (async (bytes: Uint8Array): Promise<string> => {
      const langPath =
        options.langPath === undefined
          ? resolveLangPath()
          : options.langPath;
      if (langPath === null) {
        throw new OcrError("ocr_unavailable");
      }
      return recognizeWithTesseract(bytes, langPath);
    });
  try {
    const text = await withTimeout(
      recognize(data),
      timeoutMs,
      new OcrError("ocr_timeout"),
    );
    return { text };
  } catch (err) {
    if (err instanceof OcrError) throw err;
    throw new OcrError("ocr_failed", err);
  }
}
