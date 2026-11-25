// OCR tests (2026-11-25): image-type detection by magic bytes, title
// handling for image filenames, and the OCR module with the engine
// injected — the real tesseract.js worker is NOT run here (its behaviour
// was verified by a real run against generated PNG/JPEG/WebP images; see
// PROGRESS.md). Committed tests must stay hermetic: no network, no WASM.
import { describe, expect, it } from "vitest";
import {
  OcrError,
  extractImageText,
  resolveLangPath,
} from "@/lib/documents/ocr";
import {
  MAX_UPLOAD_BYTES,
  detectFileKind,
  documentTitle,
  fileContentType,
  fileExtension,
} from "@/lib/documents/upload";

const PNG_HEAD = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const JPEG_HEAD = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
const WEBP_HEAD = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const PDF_HEAD = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3,
]);
const GIF_HEAD = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
]);
const TEXT_HEAD = new TextEncoder().encode("hello, this is");

describe("detectFileKind", () => {
  it("recognises PDF, PNG, JPEG and WebP by magic bytes", () => {
    expect(detectFileKind(PDF_HEAD)).toBe("pdf");
    expect(detectFileKind(PNG_HEAD)).toBe("png");
    expect(detectFileKind(JPEG_HEAD)).toBe("jpeg");
    expect(detectFileKind(WEBP_HEAD)).toBe("webp");
  });

  it("rejects GIF, plain text and empty input", () => {
    expect(detectFileKind(GIF_HEAD)).toBeNull();
    expect(detectFileKind(TEXT_HEAD)).toBeNull();
    expect(detectFileKind(new Uint8Array(0))).toBeNull();
  });

  it("rejects a RIFF file that is not WebP", () => {
    const riffNotWebp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]);
    expect(detectFileKind(riffNotWebp)).toBeNull();
  });

  it("rejects a truncated WebP header", () => {
    // RIFF present but fewer than 12 bytes, so the WEBP mark is unseen.
    expect(detectFileKind(WEBP_HEAD.slice(0, 8))).toBeNull();
  });
});

describe("fileExtension / fileContentType", () => {
  it("maps every kind to its storage extension and MIME type", () => {
    expect(fileExtension("pdf")).toBe("pdf");
    expect(fileExtension("png")).toBe("png");
    expect(fileExtension("jpeg")).toBe("jpg");
    expect(fileExtension("webp")).toBe("webp");
    expect(fileContentType("pdf")).toBe("application/pdf");
    expect(fileContentType("png")).toBe("image/png");
    expect(fileContentType("jpeg")).toBe("image/jpeg");
    expect(fileContentType("webp")).toBe("image/webp");
  });

  it("images share the 4 MB limit with PDFs", () => {
    expect(MAX_UPLOAD_BYTES).toBe(4194304);
  });
});

describe("documentTitle with image filenames", () => {
  it("strips image extensions like it strips .pdf", () => {
    expect(documentTitle("receipt.png", undefined)).toBe("receipt");
    expect(documentTitle("photo.JPG", undefined)).toBe("photo");
    expect(documentTitle("scan.jpeg", undefined)).toBe("scan");
    expect(documentTitle("diagram.webp", undefined)).toBe("diagram");
    expect(documentTitle("report.pdf", undefined)).toBe("report");
  });

  it("keeps a name with no known extension and falls back when empty", () => {
    expect(documentTitle("notes", undefined)).toBe("notes");
    expect(documentTitle(".png", undefined)).toBe("Untitled document");
  });

  it("the title field still wins over the filename", () => {
    expect(documentTitle("receipt.png", "Groceries")).toBe("Groceries");
  });
});

describe("resolveLangPath", () => {
  it("finds the installed English data in this repo", () => {
    const found = resolveLangPath(process.cwd());
    expect(found).not.toBeNull();
    expect(found!).toContain("@tesseract.js-data");
    expect(found!).toContain("eng");
  });

  it("returns null when no data is installed under the given root", () => {
    expect(resolveLangPath("/definitely/not/a/project")).toBeNull();
  });
});

describe("extractImageText (injected recognizer)", () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  it("returns the recognised text unchanged", async () => {
    const { text } = await extractImageText(bytes, {
      recognize: async () => "Hello OCR world 123\n",
    });
    expect(text).toBe("Hello OCR world 123\n");
  });

  it("an empty recognition is an empty string, not an error", async () => {
    const { text } = await extractImageText(bytes, {
      recognize: async () => "",
    });
    expect(text).toBe("");
  });

  it("a recognizer failure becomes OcrError ocr_failed", async () => {
    await expect(
      extractImageText(bytes, {
        recognize: async () => {
          throw new Error("pixReadStream: Unknown format");
        },
      }),
    ).rejects.toMatchObject({
      name: "OcrError",
      kind: "ocr_failed",
    } satisfies { name: string; kind: string });
    let caught: unknown;
    try {
      await extractImageText(bytes, {
        recognize: async () => {
          throw new Error("boom");
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OcrError);
    expect((caught as OcrError).kind).toBe("ocr_failed");
  });

  it("a recognizer that never settles times out honestly", async () => {
    await expect(
      extractImageText(bytes, {
        timeoutMs: 10,
        recognize: () => new Promise<string>(() => {}),
      }),
    ).rejects.toMatchObject({
      name: "OcrError",
      kind: "ocr_timeout",
    } satisfies { name: string; kind: string });
  });

  it("missing language data is ocr_unavailable, not a fake failure", async () => {
    // No injected recognizer: the module must refuse before starting a
    // worker when the data file is absent.
    await expect(
      extractImageText(bytes, { langPath: null }),
    ).rejects.toMatchObject({
      name: "OcrError",
      kind: "ocr_unavailable",
    } satisfies { name: string; kind: string });
  });
});
