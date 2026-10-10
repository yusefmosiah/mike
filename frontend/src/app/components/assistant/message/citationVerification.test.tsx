import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Citation, DocumentCitation } from "../../shared/types";
import { CitationQuotesSection } from "../CitationQuotesSection";
import { citationAriaLabel, quoteVerificationState } from "./citationVerification";

function documentCitation(verified?: boolean): DocumentCitation {
  return {
    type: "citation_data",
    kind: "document",
    ref: 1,
    doc_id: "doc-0",
    document_id: "document-1",
    filename: "agreement.pdf",
    page: 2,
    quote: "Exact source text",
    quotes: [{ page: 2, quote: "Exact source text" }],
    ...(verified === undefined ? {} : { verified }),
  };
}

const caseCitation: Citation = {
  type: "citation_data",
  kind: "case",
  ref: 2,
  cluster_id: 123,
  case_name: "Example v Example",
  quotes: [],
};

describe("citation verification presentation", () => {
  it("names a reply's citation by its number alone, located or not", () => {
    expect(citationAriaLabel(documentCitation(true))).toBe("Citation 1");
    expect(citationAriaLabel(documentCitation(false))).toBe("Citation 1");
    expect(citationAriaLabel(caseCitation)).toBe("Citation 2");
  });

  it("marks a quote unlocated only when its source match failed", () => {
    expect(quoteVerificationState({ verification: { verified: false } })).toBe("unverified");
    expect(quoteVerificationState({ verification: { verified: true } })).toBe("verified");
    expect(quoteVerificationState({})).toBe("verified");
  });

  it("disables opening an unlocated quote without a warning badge", () => {
    render(
      <CitationQuotesSection
        citationRef={7}
        quotes={[
          {
            id: "quote-1",
            quote: "Model supplied quote",
            verificationState: "unverified",
          },
        ]}
        activeQuoteId="quote-1"
      />,
    );

    expect(screen.getByLabelText("Citation 7")).toHaveTextContent("7");
    expect(screen.queryByText("Citation")).not.toBeInTheDocument();
    expect(screen.queryByText("Could not verify quote")).toBeNull();
    expect(screen.getByRole("button", { name: "View" })).toBeDisabled();
    expect(screen.getByText(/Model supplied quote/)).not.toHaveClass(
      "citation-quote-selected",
    );
  });

  it("formats normalized document quotes inside the quote section", () => {
    render(
      <CitationQuotesSection
        document={{
          document_id: "spreadsheet-1",
          title: "Damages.xlsx",
          type: "spreadsheet",
          metadata: [],
          quotes: [
            {
              quote: "1,250,000",
              target: { sheet: "Summary", cell: "B7" },
              verification: { verified: true },
            },
          ],
        }}
        activeQuoteId="spreadsheet-1:quote:0"
        citationRef={4}
      />,
    );

    expect(screen.getByText(/1,250,000/)).toHaveTextContent(
      "“1,250,000” (Summary, cell B7)",
    );
    expect(screen.getByLabelText("Citation 4")).toHaveTextContent("4");
  });
});
