import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { extractDocxBodyText, extractTrackedChangeIds } from "../docxTrackedChanges";

const W_NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/**
 * Build a minimal in-memory .docx: a zip whose word/document.xml wraps the
 * given body XML. No [Content_Types].xml etc. — the module only reads
 * word/document.xml, so this is the smallest fixture that exercises it.
 */
async function makeDocx(bodyXml: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<w:document ${W_NS}><w:body>${bodyXml}</w:body></w:document>`,
    );
    return zip.generateAsync({ type: "nodebuffer" });
}

function para(text: string): string {
    return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

describe("extractDocxBodyText", () => {
    it("joins paragraph texts with newlines", async () => {
        const bytes = await makeDocx(para("First paragraph.") + para("Second."));
        await expect(extractDocxBodyText(bytes)).resolves.toBe(
            "First paragraph.\nSecond.",
        );
    });

    it("uses the accepted view: w:ins text included, w:del text excluded", async () => {
        const bytes = await makeDocx(
            `<w:p>` +
                `<w:r><w:t xml:space="preserve">Keep </w:t></w:r>` +
                `<w:ins w:id="1"><w:r><w:t>added</w:t></w:r></w:ins>` +
                `<w:del w:id="2"><w:r><w:delText>removed</w:delText></w:r></w:del>` +
                `</w:p>`,
        );
        await expect(extractDocxBodyText(bytes)).resolves.toBe("Keep added");
    });

    it("returns an empty string when word/document.xml is missing", async () => {
        const zip = new JSZip();
        zip.file("other.txt", "not a docx");
        const bytes = await zip.generateAsync({ type: "nodebuffer" });
        await expect(extractDocxBodyText(bytes)).resolves.toBe("");
    });
});

describe("extractTrackedChangeIds", () => {
    it("lists w:ins/w:del wrappers in document order", async () => {
        const bytes = await makeDocx(
            `<w:p>` +
                `<w:ins w:id="3"><w:r><w:t>a</w:t></w:r></w:ins>` +
                `<w:del w:id="5"><w:r><w:delText>b</w:delText></w:r></w:del>` +
                `<w:ins w:id="9"><w:r><w:t>c</w:t></w:r></w:ins>` +
                `</w:p>`,
        );
        await expect(extractTrackedChangeIds(bytes)).resolves.toEqual([
            { kind: "ins", w_id: "3" },
            { kind: "del", w_id: "5" },
            { kind: "ins", w_id: "9" },
        ]);
    });

    it("returns [] when word/document.xml is missing", async () => {
        const zip = new JSZip();
        zip.file("other.txt", "not a docx");
        const bytes = await zip.generateAsync({ type: "nodebuffer" });
        await expect(extractTrackedChangeIds(bytes)).resolves.toEqual([]);
    });
});
