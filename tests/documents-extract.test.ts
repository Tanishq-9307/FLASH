// PDF extraction tests (M5-3): per-page text with page references, the
// honest no-text status for image-only PDFs, and honest failure for a
// corrupt PDF — all against real PDFs built in code (tests/fixtures/pdfs.ts)
// and the real `unpdf` extractor.
import { describe, expect, it } from "vitest";
import {
  ExtractionError,
  extractDocumentPages,
  hasNoText,
  preparePages,
  withTimeout,
} from "@/lib/documents/extract";
import {
  corruptPdf,
  imageOnlyPdf,
  multiPagePdf,
} from "./fixtures/pdfs";

describe("extractDocumentPages", () => {
  it("multi-page fixture maps text to the correct pages", async () => {
    const { pages } = await extractDocumentPages(multiPagePdf());
    expect(pages).toHaveLength(3);
    expect(pages[0]).toContain("budget is five thousand rupees");
    expect(pages[1]).toContain("Travel costs are capped at one thousand");
    expect(pages[2]).toContain("deadline is the thirtieth of November");
    expect(hasNoText(pages)).toBe(false);
  });

  it("image-only PDF extracts no text on any page", async () => {
    const { pages } = await extractDocumentPages(imageOnlyPdf());
    expect(pages).toHaveLength(1);
    expect(hasNoText(pages)).toBe(true);
  });

  it("corrupt PDF fails honestly with extraction_failed", async () => {
    await expect(extractDocumentPages(corruptPdf())).rejects.toMatchObject({
      name: "ExtractionError",
      kind: "extraction_failed",
    } satisfies { name: string; kind: string });
    // The error is an ExtractionError, not a raw parser error.
    let caught: unknown;
    try {
      await extractDocumentPages(corruptPdf());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExtractionError);
    expect((caught as ExtractionError).kind).toBe("extraction_failed");
  });
});

describe("withTimeout", () => {
  it("a never-resolving promise rejects with the given error", async () => {
    const error = new Error("too slow");
    await expect(
      withTimeout(new Promise(() => {}), 10, error),
    ).rejects.toBe(error);
  });

  it("a fast promise resolves with its value", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, new Error("x"))).resolves.toBe(42);
  });
});

describe("preparePages", () => {
  it("numbers pages 1..n and leaves normal text untouched", () => {
    const { pages, truncated } = preparePages(["one", "two"]);
    expect(pages).toEqual([
      { page: 1, text: "one" },
      { page: 2, text: "two" },
    ]);
    expect(truncated).toBe(false);
  });

  it("cuts a page over 20,000 characters and reports the cut", () => {
    const long = "x".repeat(20001);
    const { pages, truncated } = preparePages(["short", long]);
    expect(pages[0]).toEqual({ page: 1, text: "short" });
    expect(pages[1].page).toBe(2);
    expect(pages[1].text).toHaveLength(20000);
    expect(truncated).toBe(true);
  });
});

describe("hasNoText", () => {
  it("empty and whitespace-only pages count as no text", () => {
    expect(hasNoText(["", "   ", "\n"])).toBe(true);
    expect(hasNoText(["", "word"])).toBe(false);
  });
});
