import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { uploadFileMock } = vi.hoisted(() => ({
  uploadFileMock: vi.fn(),
}));

vi.mock("../storage", () => ({
  downloadFile: vi.fn(),
  generatedDocKey: (userId: string, docId: string, filename: string) =>
    `generated/${userId}/${docId}/${filename}`,
  uploadFile: (...args: unknown[]) => uploadFileMock(...args),
}));

vi.mock("../downloadTokens", () => ({
  buildDownloadUrl: () => "/download/test-token",
}));

import { generateDocx } from "../../modules/chat/engine/tools/documentOps";

function fakeDb() {
  return {
    rpc: vi.fn(async () => ({ data: { id: "version-1", version_number: 1 }, error: null })),
    from(table: string) {
      const result = { data: null, error: null };
      const query: Record<string, unknown> = {};
      query.insert = vi.fn(() => query);
      query.select = vi.fn(() => query);
      query.update = vi.fn(() => query);
      query.eq = vi.fn(() => query);
      query.single = vi.fn(async () => ({
        data: { id: table === "documents" ? "doc-1" : "version-1" },
        error: null,
      }));
      query.then = (
        resolve: (value: typeof result) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject);
      return query;
    },
  };
}

async function generatedXml(options: {
  sections: unknown[];
  numberSections?: boolean;
  footnotes?: Record<string, string>;
}): Promise<{
  documentXml: string;
  numberingXml: string;
  footnotesXml: string | null;
}> {
  let bytes: ArrayBuffer | undefined;
  uploadFileMock.mockImplementationOnce(
    async (_key: string, uploaded: ArrayBuffer) => {
      bytes = uploaded;
    },
  );

  const result = await generateDocx(
    "Generated document",
    options.sections,
    "test-user",
    fakeDb() as never,
    {
      numberSections: options.numberSections,
      footnotes: options.footnotes,
    },
  );

  expect(result).not.toHaveProperty("error");
  expect(bytes).toBeDefined();
  const archive = await JSZip.loadAsync(bytes!);
  const documentXml = await archive.file("word/document.xml")!.async("string");
  const numberingXml =
    (await archive.file("word/numbering.xml")?.async("string")) ?? "";
  const footnotesXml =
    (await archive.file("word/footnotes.xml")?.async("string")) ?? null;
  return { documentXml, numberingXml, footnotesXml };
}

function paragraphContaining(xml: string, text: string): string {
  return (
    xml
      .match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)
      ?.find((paragraph) => paragraph.includes(text)) ?? ""
  );
}

beforeEach(() => {
  uploadFileMock.mockReset();
});

describe("generateDocx numbering", () => {
  it("leaves demand-letter headings and prose unnumbered by default", async () => {
    const { documentXml } = await generatedXml({
      sections: [
        {
          heading: "Demand for Payment",
          content:
            "We represent the claimant.\nPayment is required within ten days.",
        },
      ],
    });

    expect(paragraphContaining(documentXml, "DEMAND FOR PAYMENT")).not.toContain(
      "<w:numPr>",
    );
    expect(
      paragraphContaining(documentXml, "We represent the claimant."),
    ).not.toContain("<w:numPr>");
    expect(
      paragraphContaining(documentXml, "Payment is required within ten days."),
    ).not.toContain("<w:numPr>");
  });

  it("numbers only headings when legal section numbering is requested", async () => {
    const { documentXml } = await generatedXml({
      numberSections: true,
      sections: [
        {
          heading: "Payment Terms",
          content: "Payment is due monthly.\nInvoices are payable in ten days.",
        },
      ],
    });

    expect(paragraphContaining(documentXml, "PAYMENT TERMS")).toContain(
      "<w:numPr>",
    );
    expect(paragraphContaining(documentXml, "Payment is due monthly.")).not.toContain(
      "<w:numPr>",
    );
    expect(
      paragraphContaining(documentXml, "Invoices are payable in ten days."),
    ).not.toContain("<w:numPr>");
  });

  it("preserves manually typed numbering when automatic numbering is off", async () => {
    const { documentXml } = await generatedXml({
      sections: [{ content: "1. This reference is intentional." }],
    });
    const paragraph = paragraphContaining(
      documentXml,
      "1. This reference is intentional.",
    );

    expect(paragraph).toContain("1. This reference is intentional.");
    expect(paragraph).not.toContain("<w:numPr>");
  });

  it("renders explicit bullets as bullets rather than legal clauses", async () => {
    const { documentXml, numberingXml } = await generatedXml({
      numberSections: true,
      sections: [
        {
          heading: "Requirements",
          content: "- First item\n- Second item",
        },
      ],
    });

    const first = paragraphContaining(documentXml, "First item");
    const second = paragraphContaining(documentXml, "Second item");
    expect(first).toContain("<w:numPr>");
    expect(second).toContain("<w:numPr>");
    expect(first).not.toContain("- First item");
    expect(second).not.toContain("- Second item");
    expect(numberingXml).toContain('<w:numFmt w:val="bullet"/>');
  });
});
describe("generateDocx footnotes", () => {
  it("compiles markdown footnote citations and definitions into native OpenXML footnotes", async () => {
    const { documentXml, footnotesXml } = await generatedXml({
      sections: [
        {
          heading: "Fiduciary Duties",
          content:
            "Directors owe a duty of loyalty under Delaware law[^1].\n" +
            "This extends to corporate opportunities[^2].\n\n" +
            "[^1]: See Guth v. Loft, Inc., 5 A.2d 503 (Del. 1939).\n" +
            "[^2]: See Broz v. Cellular Information Systems, Inc., 673 A.2d 148 (Del. 1996).",
        },
      ],
    });

    // Body paragraph contains native OpenXML footnoteReference runs
    expect(documentXml).toContain("<w:footnoteReference");
    expect(footnotesXml).not.toBeNull();
    // word/footnotes.xml contains the actual citation text
    expect(footnotesXml).toContain("Guth v. Loft, Inc.");
    expect(footnotesXml).toContain("Broz v. Cellular Information Systems");
    // Body paragraphs do not leak the raw definition lines
    expect(documentXml).not.toContain("[^1]: See Guth");
    expect(documentXml).not.toContain("[^2]: See Broz");
  });

  it("compiles structured footnotes parameter into native footnotes", async () => {
    const { documentXml, footnotesXml } = await generatedXml({
      sections: [
        {
          heading: "Standard of Review",
          content: "The business judgment rule applies by default[^1].",
        },
      ],
      footnotes: {
        "1": "Aronson v. Lewis, 473 A.2d 805 (Del. 1984).",
      },
    });

    expect(documentXml).toContain("<w:footnoteReference");
    expect(footnotesXml).not.toBeNull();
    expect(footnotesXml).toContain("Aronson v. Lewis");
  });

  it("converts bracketed markers (§1§ and [2]) to footnotes when defined in footnotes map", async () => {
    const { documentXml, footnotesXml } = await generatedXml({
      sections: [
        {
          heading: "Statutory Basis",
          content:
            "Governed by Delaware General Corporation Law §1§ and liability cap [2]. Regular brackets like [Schedule A] stay plain text.",
        },
      ],
      footnotes: {
        "1": "8 Del. C. § 141(a).",
        "2": "8 Del. C. § 102(b)(7).",
      },
    });

    expect(documentXml).toContain("<w:footnoteReference");
    expect(footnotesXml).not.toBeNull();
    expect(footnotesXml).toContain("8 Del. C. § 141(a)");
    expect(footnotesXml).toContain("8 Del. C. § 102(b)(7)");
    // Normal bracketed text without a matching footnote is preserved as plain text
    expect(documentXml).toContain("[Schedule A]");
  });

  it("omits user footnote references when a document has no footnotes", async () => {
    const { documentXml, footnotesXml } = await generatedXml({
      sections: [
        {
          heading: "Summary",
          content: "This is a clean document with no footnotes.",
        },
      ],
    });

    expect(documentXml).not.toContain("<w:footnoteReference");
    // Standard Word separator entries (-1, 0) exist in OpenXML, but no user footnote (w:id="1")
    expect(footnotesXml).not.toContain('w:id="1"');
  });
});
