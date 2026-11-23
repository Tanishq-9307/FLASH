// Citation verification (M5-4): a citation is only evidence if it points
// at a page the model was actually shown.
//
// The model cites pages as `[p. N]`. This module parses those markers out
// of a reply and checks each one against the pages that were retrieved for
// the question. A citation to a page the model never saw cannot be verified
// — the model may have invented the number — so the answer is flagged and
// the route appends a system note saying so, instead of presenting the
// reply as sourced. An explicit "the document does not say" needs no
// citations: declining is the honest answer, not a failure to cite.

export interface CitationCheck {
  page: number;
  ok: boolean;
  reason?: string;
}

export interface CitationVerification {
  status: "verified" | "unverified" | "declined";
  citations: CitationCheck[];
  problems: string[];
}

const CITATION_RE = /\[p\.\s*(\d+)\]/g;
const DECLINE_RE = /the document does not say/i;

/** Every `[p. N]` marker in the text, in order. */
export function extractCitations(text: string): number[] {
  const pages: number[] = [];
  for (const match of text.matchAll(CITATION_RE)) {
    pages.push(Number(match[1]));
  }
  return pages;
}

/**
 * Verify a document answer's citations against the pages retrieved for the
 * question. 'verified' means every citation points at a retrieved page;
 * 'unverified' means a citation is missing or points elsewhere; 'declined'
 * means the answer says the document does not say.
 */
export function verifyAnswerCitations(
  answer: string,
  retrievedPages: Array<{ page_number: number }>,
): CitationVerification {
  if (DECLINE_RE.test(answer)) {
    return { status: "declined", citations: [], problems: [] };
  }
  const cited = extractCitations(answer);
  if (cited.length === 0) {
    return {
      status: "unverified",
      citations: [],
      problems: ["the answer cites no page"],
    };
  }
  const seen = new Set(retrievedPages.map((page) => page.page_number));
  const citations: CitationCheck[] = cited.map((page) =>
    seen.has(page)
      ? { page, ok: true }
      : {
          page,
          ok: false,
          reason: "page was not among the retrieved pages",
        },
  );
  const problems = citations
    .filter((citation) => !citation.ok)
    .map(
      (citation) =>
        `citation [p. ${citation.page}] points to a page the model was not shown`,
    );
  return {
    status: problems.length === 0 ? "verified" : "unverified",
    citations,
    problems,
  };
}
