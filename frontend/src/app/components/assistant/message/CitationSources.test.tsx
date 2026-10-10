import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Citation, DocumentCitation } from "../../shared/types";
import { citationTooltip, CitationsBlock } from "./CitationSources";

function documentCitation(ref: number, verified?: boolean): DocumentCitation {
  return {
    type: "citation_data",
    kind: "document",
    ref,
    doc_id: `doc-${ref}`,
    document_id: `document-${ref}`,
    filename: `source-${ref}.pdf`,
    page: ref,
    quote: `Quote ${ref}`,
    quotes: [{ page: ref, quote: `Quote ${ref}` }],
    ...(verified === undefined ? {} : { verified }),
  };
}

describe("CitationsBlock verification states", () => {
  it("styles a reply's citations alike whether or not the quote was located", () => {
    render(
      <CitationsBlock
        citations={[documentCitation(1, false), documentCitation(2)]}
      />,
    );

    for (const name of ["Citation 1", "Citation 2"]) {
      expect(screen.getByRole("button", { name })).toHaveClass(
        "bg-gray-200/80",
        "text-gray-800",
      );
    }
  });

  it("carries no verification warning in citation tooltips", () => {
    expect(citationTooltip(documentCitation(3, false))).not.toContain("matched");
  });

  it("leaves case citations outside document verification styling", () => {
    const citation: Citation = {
      type: "citation_data",
      kind: "case",
      ref: 4,
      cluster_id: 99,
      case_name: "Example v Example",
      quotes: [],
    };
    render(<CitationsBlock citations={[citation]} />);

    const button = screen.getByRole("button", { name: "Citation 4" });
    expect(button).toHaveClass("bg-gray-200/80", "text-gray-800");
  });

  it("adds the selected quote background only to the active citation", () => {
    const inactive = documentCitation(1);
    const active = documentCitation(2);

    render(
      <CitationsBlock
        citations={[inactive, active]}
        activeCitation={active}
      />,
    );

    expect(screen.getByRole("button", { name: "Citation 2" })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Citation 2" }),
    ).toHaveAttribute("aria-current", "true");
    expect(
      screen.getByRole("button", { name: "Citation 1" }),
    ).not.toHaveAttribute("data-active");
  });
});

describe("web citations", () => {
  const web: Citation = {
    type: "citation_data",
    kind: "web",
    ref: 1,
    url: "https://www.rocketswire.com/game",
    title: "Rockets rout Mavs in Macao",
    site: "rocketswire.com",
    quotes: [{ quote: "Houston won 135-117" }],
  };

  it("lists the page by title and site, with its quote in the tooltip", () => {
    render(<CitationsBlock citations={[web]} />);
    expect(screen.getByText("Rockets rout Mavs in Macao (rocketswire.com)")).toBeInTheDocument();
    expect(citationTooltip(web)).toBe('rocketswire.com: "Houston won 135-117"');
  });
});
