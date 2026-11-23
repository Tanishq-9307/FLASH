// Citation verification unit tests (M5-4): parsing `[p. N]` markers and
// checking them against the pages the model was shown.
import { describe, expect, it } from "vitest";
import {
  extractCitations,
  verifyAnswerCitations,
} from "@/lib/documents/citations";

describe("extractCitations", () => {
  it("finds page markers in order", () => {
    expect(
      extractCitations("See [p. 1] and [p. 12] for details."),
    ).toEqual([1, 12]);
  });

  it("ignores non-markers and returns none when there are no citations", () => {
    expect(extractCitations("See page 2 and [p. x] for details.")).toEqual([]);
    expect(extractCitations("No citations here.")).toEqual([]);
  });

  it("tolerates spacing inside the marker", () => {
    expect(extractCitations("As shown in [p.  3].")).toEqual([3]);
  });
});

describe("verifyAnswerCitations", () => {
  const retrieved = [{ page_number: 1 }, { page_number: 2 }];

  it("verified when every citation points at a retrieved page", () => {
    const result = verifyAnswerCitations(
      "The budget is five thousand [p. 1] and travel is capped [p. 2].",
      retrieved,
    );
    expect(result.status).toBe("verified");
    expect(result.problems).toEqual([]);
    expect(result.citations).toEqual([
      { page: 1, ok: true },
      { page: 2, ok: true },
    ]);
  });

  it("unverified when the answer cites no page", () => {
    const result = verifyAnswerCitations(
      "The budget is five thousand rupees.",
      retrieved,
    );
    expect(result.status).toBe("unverified");
    expect(result.problems).toEqual(["the answer cites no page"]);
  });

  it("unverified when a citation points at a page the model never saw", () => {
    const result = verifyAnswerCitations(
      "The deadline is November [p. 3].",
      retrieved,
    );
    expect(result.status).toBe("unverified");
    expect(result.citations).toEqual([
      {
        page: 3,
        ok: false,
        reason: "page was not among the retrieved pages",
      },
    ]);
    expect(result.problems).toEqual([
      "citation [p. 3] points to a page the model was not shown",
    ]);
  });

  it("declined when the answer says the document does not say", () => {
    const result = verifyAnswerCitations(
      "The document does not say what the deadline is.",
      retrieved,
    );
    expect(result.status).toBe("declined");
    expect(result.citations).toEqual([]);
    expect(result.problems).toEqual([]);
  });
});
