import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { lintDocx } from "../docxLinter";

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

describe("lintDocx", () => {
  it("passes a clean document with no errors or warnings", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body><w:p><w:r><w:t>Clean text</w:t></w:r></w:p></w:body></w:document>`,
    );

    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const res = await lintDocx(bytes);

    expect(res.ok).toBe(true);
    expect(res.errorCount).toBe(0);
    expect(res.warningCount).toBe(0);
  });

  it("exempts standard OpenXML separators (-1 and 0) from orphan footnote warnings", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body><w:p><w:r><w:t>Paragraph with footnote</w:t><w:footnoteReference w:id="1"/></w:r></w:p></w:body></w:document>`,
    );
    zip.file(
      "word/footnotes.xml",
      `<?xml version="1.0" encoding="UTF-8"?><w:footnotes ${W_NS}>` +
        `<w:footnote w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>` +
        `<w:footnote w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>` +
        `<w:footnote w:id="1"><w:p><w:r><w:t>Citation text</w:t></w:r></w:p></w:footnote>` +
        `</w:footnotes>`,
    );

    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const res = await lintDocx(bytes);

    expect(res.ok).toBe(true);
    expect(res.errorCount).toBe(0);
    // Separators -1 and 0 must NOT trigger orphan warnings
    expect(res.issues.some((i) => i.target === "-1" || i.target === "0")).toBe(false);
  });

  it("catches dangling footnote references where body cites a missing definition", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body><w:p><w:r><w:t>Text</w:t><w:footnoteReference w:id="99"/></w:r></w:p></w:body></w:document>`,
    );
    zip.file(
      "word/footnotes.xml",
      `<?xml version="1.0" encoding="UTF-8"?><w:footnotes ${W_NS}>` +
        `<w:footnote w:id="1"><w:p><w:r><w:t>Def 1</w:t></w:r></w:p></w:footnote>` +
        `</w:footnotes>`,
    );

    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const res = await lintDocx(bytes);

    expect(res.ok).toBe(false);
    expect(res.errorCount).toBe(1);
    expect(res.issues[0]).toMatchObject({
      severity: "error",
      category: "footnote",
      target: "99",
    });
  });

  it("catches dangling relationship references missing from document.xml.rels", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body><w:p><w:hyperlink r:id="rIdMissing"><w:r><w:t>Link</w:t></w:r></w:hyperlink></w:p></w:body></w:document>`,
    );
    zip.file(
      "word/_rels/document.xml.rels",
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="hyperlink" Target="https://valid.com"/></Relationships>`,
    );

    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const res = await lintDocx(bytes);

    expect(res.ok).toBe(false);
    expect(res.errorCount).toBe(1);
    expect(res.issues[0]).toMatchObject({
      severity: "error",
      category: "relationship",
      target: "rIdMissing",
    });
  });

  it("reports package error for invalid zip or missing document.xml", async () => {
    const invalidBytes = Buffer.from("not a zip package");
    const res = await lintDocx(invalidBytes);

    expect(res.ok).toBe(false);
    expect(res.issues[0].category).toBe("package");
  });
});

describe("lintDocx revision structure", () => {
  const doc = async (body: string) => {
    const zip = new JSZip();
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body>${body}</w:body></w:document>`);
    return lintDocx(await zip.generateAsync({ type: "nodebuffer" }));
  };

  it("accepts well-formed tracked changes, including a deletion nested in an insertion", async () => {
    const res = await doc(
      `<w:p><w:pPr><w:rPr><w:ins w:id="1" w:author="A"/></w:rPr></w:pPr><w:ins w:id="2" w:author="A"><w:r><w:t>kept</w:t></w:r><w:del w:id="3" w:author="B"><w:r><w:delText>gone</w:delText></w:r></w:del></w:ins></w:p>`,
    );
    expect(res.issues).toEqual([]);
  });

  it("accepts moved-from text written as w:t, as Word writes it", async () => {
    const res = await doc(`<w:p><w:moveFrom w:id="1" w:author="A"><w:r><w:t>moved</w:t></w:r></w:moveFrom></w:p>`);
    expect(res.issues).toEqual([]);
  });

  it("flags w:t inside a deletion, stray w:delText, and duplicate ids", async () => {
    const res = await doc(
      `<w:p><w:del w:id="1" w:author="A"><w:r><w:t>x</w:t></w:r></w:del><w:r><w:delText>y</w:delText></w:r><w:ins w:id="1" w:author="A"><w:r><w:t>z</w:t></w:r></w:ins></w:p>`,
    );
    expect(res.issues.map((i) => i.message)).toEqual([
      "Text inside a tracked deletion is w:t instead of w:delText",
      "w:delText outside a tracked deletion",
      "Tracked-change id 1 is used 2 times",
    ]);
  });

  it("flags a table without rows and a cell without a final paragraph", async () => {
    const res = await doc(`<w:tbl><w:tblPr/></w:tbl><w:tbl><w:tr><w:tc><w:tcPr/></w:tc></w:tr></w:tbl><w:p/>`);
    expect(res.issues.map((i) => i.message)).toEqual(["Table without rows", "Table cell does not end with a paragraph"]);
  });
});
