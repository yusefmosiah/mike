import { describe, expect, it } from "vitest";
import { readCorpusFile } from "../../../__tests__/helpers/docxCorpus";
import { renderDocxRead } from "../read";
import { findSections } from "../render";
import { DocxDocument } from "../view";

const MSC = "public-legal/uk-msc-core-terms-v2.2a.docx";

/** Clause labels of the blocks a section read returns. */
function labels(doc: DocxDocument, query: string): string[] {
  const [m] = findSections(doc, query);
  return doc.blocks.slice(m.start, m.end).flatMap((b) => (b.kind === "paragraph" && b.fullLabel ? [b.fullLabel] : []));
}

describe("section reads on a real contract", () => {
  it("a sub-clause heading includes its sub-clauses and stops at the next sibling", async () => {
    const doc = await DocxDocument.load(readCorpusFile(MSC));
    const got = labels(doc, "5.3");
    expect(got[0]).toBe("5.3");
    expect(got).toContain("5.3.1");
    expect(got).toContain("5.3.1(g)");
    expect(got.at(-1)).toBe("5.3.3");
    expect(got).not.toContain("5.4");
  });

  it("a top-level clause runs to the next top-level clause", async () => {
    const doc = await DocxDocument.load(readCorpusFile(MSC));
    const got = labels(doc, "5");
    expect(got[0]).toBe("5.");
    expect(got).toContain("5.3.3");
    expect(got.some((l) => l.startsWith("6"))).toBe(false);
    expect(got.length).toBeGreaterThan(10);
  });

  it("read_document returns the clause text for a section", async () => {
    const doc = await DocxDocument.load(readCorpusFile(MSC));
    const { text } = renderDocxRead(doc, { section: "5.3" });
    expect(text).toContain("[0000011B] 5.3.1 perform its obligations under this Contract");
    expect(text).toContain("5.3.3 deliver the Services");
    expect(text).toContain("[End of section 5.3.]");
  });
});
