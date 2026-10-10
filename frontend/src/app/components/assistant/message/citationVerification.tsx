import type { Citation, DocumentCitationQuote } from "../../shared/types";

// Whether a reply's quote was located in its source. A quote that was not
// located has nothing to highlight, so it cannot be opened at a position;
// replies' citations are otherwise trusted and carry no warning badge.
export type CitationVerificationDisplayState = "verified" | "unverified";

export function quoteVerificationState(
  quote: Pick<DocumentCitationQuote, "verification">,
): CitationVerificationDisplayState {
  return quote.verification?.verified === false ? "unverified" : "verified";
}

export function citationAriaLabel(citation: Citation): string {
  return `Citation ${citation.ref}`;
}

export const UNLOCATED_QUOTE_TITLE = "This passage was not located in the source";
