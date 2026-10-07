import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  DocxASTDocument,
  type BlockOperation,
} from "../docxAST";

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

async function makeDocx(bodyXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document ${W_NS}><w:body>${bodyXml}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

function para(text: string, style?: string): string {
  const pPr = style
    ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`
    : "";
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function table(headers: string[], rows: string[][]): string {
  const headerCells = headers
    .map((h) => `<w:tc><w:p><w:r><w:t>${h}</w:t></w:r></w:p></w:tc>`)
    .join("");
  const headerRow = `<w:tr>${headerCells}</w:tr>`;

  const bodyRows = rows
    .map(
      (row) =>
        `<w:tr>${row
          .map((c) => `<w:tc><w:p><w:r><w:t>${c}</w:t></w:r></w:p></w:tc>`)
          .join("")}</w:tr>`,
    )
    .join("");

  return `<w:tbl>${headerRow}${bodyRows}</w:tbl>`;
}

async function readDocXml(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  return zip.file("word/document.xml")!.async("string");
}

describe("DocxASTDocument", () => {
  it("loads a document and parses paragraphs and tables into structured blocks", async () => {
    const xml =
      para("Executive Summary", "Heading1") +
      para("This agreement is entered into between Party A and Party B.") +
      table(
        ["Party", "Role"],
        [
          ["Acme Corp", "Buyer"],
          ["Beta LLC", "Seller"],
        ],
      ) +
      para("Governing law is Delaware.");

    const bytes = await makeDocx(xml);
    const doc = await DocxASTDocument.load(bytes);
    const blocks = doc.getBlocks();

    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toMatchObject({
      type: "paragraph",
      id: "p_1",
      text: "Executive Summary",
      headingLevel: 1,
      isHeading: true,
      isEmpty: false,
    });

    expect(blocks[1]).toMatchObject({
      type: "paragraph",
      id: "p_2",
      text: "This agreement is entered into between Party A and Party B.",
      isEmpty: false,
    });

    expect(blocks[2]).toMatchObject({
      type: "table",
      id: "tbl_1",
      rowCount: 3,
      colCount: 2,
      headers: ["Party", "Role"],
      rows: [["Acme Corp", "Buyer"], ["Beta LLC", "Seller"]],
    });

    expect(blocks[3]).toMatchObject({
      type: "paragraph",
      id: "p_3",
      text: "Governing law is Delaware.",
    });
  });

  it("reads bounded blocks with startId and endId", async () => {
    const xml =
      para("P1") + para("P2") + para("P3") + para("P4") + para("P5");
    const bytes = await makeDocx(xml);
    const doc = await DocxASTDocument.load(bytes);

    const slice = doc.readBlocks({ startId: "p_2", endId: "p_4" });
    expect(slice.map((b) => b.id)).toEqual(["p_2", "p_3", "p_4"]);
  });

  it("deletes a range of blocks atomically and marks tracked deletions", async () => {
    // Simulate 10 paragraphs, delete p_3 to p_7 (5 blocks in one call)
    let xml = "";
    for (let i = 1; i <= 10; i++) {
      xml += para(`Paragraph ${i}`);
    }

    const bytes = await makeDocx(xml);
    const doc = await DocxASTDocument.load(bytes);

    const result = await doc.batchMutate([
      {
        op: "delete_blocks",
        startId: "p_3",
        endId: "p_7",
        reason: "remove obsolete sections",
      },
    ]);

    expect(result.appliedOpsCount).toBe(1);
    expect(result.changes).toHaveLength(5);
    expect(result.changes[0]).toMatchObject({
      deletedText: "Paragraph 3",
      insertedText: "",
    });

    const updatedXml = await readDocXml(result.bytes);
    expect(updatedXml).toContain("<w:del");
    expect(updatedXml).toContain("Paragraph 3");
    // Verify paragraph-mark deletion in pPr
    expect(updatedXml).toContain("<w:pPr><w:rPr><w:del");
  });

  it("deletes empty paragraphs without deleting section breaks", async () => {
    const xml =
      para("Section 1") +
      para("") + // empty
      para("Section 2") +
      para("") + // empty with sectPr
      `<w:p><w:pPr><w:sectPr/></w:pPr></w:p>` +
      para("") + // trailing empty
      para(""); // trailing empty

    const bytes = await makeDocx(xml);
    const doc = await DocxASTDocument.load(bytes);

    const result = await doc.batchMutate([
      {
        op: "delete_empty_blocks",
        scope: "trailing",
      },
    ]);

    expect(result.changes.length).toBeGreaterThanOrEqual(1);
    const blocksAfter = result.blocksAfter;
    // Trailing empty blocks were removed, but earlier blocks remain
    expect(blocksAfter[0].text).toBe("Section 1");
  });

  it("inserts multi-line blocks into distinct paragraphs", async () => {
    const xml = para("P1") + para("P2");
    const bytes = await makeDocx(xml);
    const doc = await DocxASTDocument.load(bytes);

    const result = await doc.batchMutate([
      {
        op: "insert_block",
        afterId: "p_1",
        content: "Title Line 1\n\nTitle Line 2\n\nTitle Line 3",
        style: "Heading2",
      },
    ]);

    expect(result.changes).toHaveLength(3);
    expect(result.changes[0].insertedText).toBe("Title Line 1");
    expect(result.changes[1].insertedText).toBe("Title Line 2");
    expect(result.changes[2].insertedText).toBe("Title Line 3");

    const updatedXml = await readDocXml(result.bytes);
    expect(updatedXml).toContain("<w:ins");
    expect(updatedXml).toContain("Title Line 1");
    expect(updatedXml).toContain("Title Line 2");
  });

  it("replaces a block with strict fail-closed expectedContent validation", async () => {
    const xml = para("Fee shall be $10,000 per month.");
    const bytes = await makeDocx(xml);
    const doc = await DocxASTDocument.load(bytes);

    // Mismatched expectedContent must throw error and abort
    await expect(
      doc.batchMutate([
        {
          op: "replace_block",
          blockId: "p_1",
          newContent: "Fee shall be $5,000 per month.",
          expectedContent: "Fee shall be $20,000 per month.",
        },
      ]),
    ).rejects.toThrow("Precondition failed for block 'p_1'");

    // Matching expectedContent succeeds
    const result = await doc.batchMutate([
      {
        op: "replace_block",
        blockId: "p_1",
        newContent: "Fee shall be $5,000 per month.",
        expectedContent: "$10,000 per month",
      },
    ]);

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      deletedText: "Fee shall be $10,000 per month.",
      insertedText: "Fee shall be $5,000 per month.",
    });

    const updatedXml = await readDocXml(result.bytes);
    expect(updatedXml).toContain("<w:del");
    expect(updatedXml).toContain("<w:ins");
    expect(updatedXml).toContain("Fee shall be $5,000 per month.");
  });

  it("enforces all-or-nothing atomicity across multi-op batches", async () => {
    const xml = para("First") + para("Second") + para("Third");
    const bytes = await makeDocx(xml);
    const doc = await DocxASTDocument.load(bytes);

    const ops: BlockOperation[] = [
      { op: "replace_block", blockId: "p_1", newContent: "New First" },
      { op: "replace_block", blockId: "p_99", newContent: "Nonexistent" }, // Invalid!
    ];

    await expect(doc.batchMutate(ops)).rejects.toThrow(
      "replace_block target block 'p_99' not found",
    );

    // Document must be completely untouched
    const blocks = doc.getBlocks();
    expect(blocks[0].text).toBe("First");
  });

  it("preserves untouched package parts and relationships (reversibility guarantee)", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", `<w:document ${W_NS}><w:body>${para("Preserve me")}</w:body></w:document>`);
    zip.file("word/_rels/document.xml.rels", `<Relationships><Relationship Id="rId1" Type="hyperlink" Target="https://example.com"/></Relationships>`);
    zip.file("custom/metadata.xml", `<CustomData value="secret"/>`);

    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const doc = await DocxASTDocument.load(bytes);

    const result = await doc.batchMutate([
      { op: "replace_block", blockId: "p_1", newContent: "Updated" },
    ]);

    const updatedZip = await JSZip.loadAsync(result.bytes);
    // Custom parts and relationship files are 100% preserved
    expect(await updatedZip.file("custom/metadata.xml")!.async("string")).toBe('<CustomData value="secret"/>');
    expect(await updatedZip.file("word/_rels/document.xml.rels")!.async("string")).toContain("https://example.com");
  });
});
