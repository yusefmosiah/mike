import JSZip from "jszip";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import { readCorpusFile } from "../../../__tests__/helpers/docxCorpus";
import { DocxDocument } from "../../docx/view";
import { extractPdfPages } from "../../pdfText";
import {
    docxToModel,
    markdownToModel,
    pdfToModel,
    presentationToModel,
    spreadsheetToModel,
    textToModel,
    type DocBlock,
} from "..";

const shape = (blocks: DocBlock[]) => blocks.map((b) => [b.id, b.kind, b.level ?? null, b.label ?? null, b.text]);

describe("Markdown", () => {
    it("reads headings, lists, code, quotes, tables and paragraphs with their lines", () => {
        const model = markdownToModel(
            [
                "Title",
                "=====",
                "",
                "Intro paragraph that",
                "runs on two lines.",
                "",
                "## Terms",
                "",
                "1. First term",
                "   continues here",
                "2) Second term",
                "  - nested point",
                "",
                "> Quoted words",
                "> more quoted",
                "",
                "```python",
                "print('hi')",
                "```",
                "",
                "---",
                "",
                "| A | B |",
                "|---|:-:|",
                "| 1 | x \\| y |",
            ].join("\n"),
        );
        expect(shape(model.blocks)).toEqual([
            ["m1", "heading", 1, null, "Title"],
            ["m4", "paragraph", null, null, "Intro paragraph that runs on two lines."],
            ["m7", "heading", 2, null, "Terms"],
            ["m9", "list_item", 1, "1.", "First term continues here"],
            ["m11", "list_item", 1, "2)", "Second term"],
            ["m12", "list_item", 2, null, "nested point"],
            ["m14", "quote", null, null, "Quoted words\nmore quoted"],
            ["m17", "code", null, null, "print('hi')"],
            ["m23", "table", null, null, "A | B\n1 | x | y"],
        ]);
        expect(model.blocks[1].source).toBe("lines 4-5");
        expect(model.blocks[7].language).toBe("python");
        expect(model.blocks[8].rows).toEqual([["A", "B"], ["1", "x | y"]]);
    });

    it("reads plain text as paragraphs only", () => {
        const model = textToModel("# not a heading\nsame paragraph\n\nsecond");
        expect(shape(model.blocks)).toEqual([
            ["m1", "paragraph", null, null, "# not a heading\nsame paragraph"],
            ["m4", "paragraph", null, null, "second"],
        ]);
    });
});

describe("docx", () => {
    it("keeps the document view's ids, clause numbers and headings", async () => {
        const doc = await DocxDocument.load(readCorpusFile("public-legal/uk-msc-core-terms-v2.2a.docx"));
        const model = docxToModel(doc);
        const ids = new Set(doc.blocks.map((b) => b.id));
        expect(model.blocks.length).toBeGreaterThan(100);
        expect(model.blocks.filter((b) => b.kind !== "note").every((b) => ids.has(b.id))).toBe(true);
        const clause = model.blocks.find((b) => b.label === "5.3.1");
        expect(clause?.text).toContain("perform its obligations under this Contract");
        expect(model.blocks.some((b) => b.kind === "heading")).toBe(true);
        expect(new Set(model.blocks.map((b) => b.id)).size).toBe(model.blocks.length);
    });
});

/** A small PDF: three pages, a running header and page numbers, bookmarks, and set type sizes. */
function buildPdf(): ArrayBuffer {
    const page = (n: number, body: string[]) =>
        [
            "BT /F1 9 Tf 72 760 Td (Confidential - Draft) Tj ET",
            ...body,
            `BT /F1 9 Tf 300 40 Td (${n}) Tj ET`,
        ].join("\n");
    const contents = [
        page(1, [
            "BT /F1 20 Tf 72 700 Td (MASTER SERVICES AGREEMENT) Tj ET",
            "BT /F1 14 Tf 72 660 Td (1. Definitions) Tj ET",
            "BT /F1 11 Tf 72 636 Td (In this Agreement the following words have the) Tj ET",
            "BT /F1 11 Tf 72 622 Td (meanings set out below.) Tj ET",
            "BT /F1 11 Tf 72 596 Td (1.1 Services means the work in Schedule 1.) Tj ET",
            "BT /F1 11 Tf 72 582 Td (\\(a\\) including support.) Tj ET",
        ]),
        page(2, [
            "BT /F1 14 Tf 72 700 Td (2. Fees) Tj ET",
            "BT /F1 11 Tf 72 676 Td (The Customer pays the fees within thirty days.) Tj ET",
        ]),
        page(3, [
            "BT /F1 11 Tf 72 700 Td (SCHEDULE 1) Tj ET",
            "BT /F1 11 Tf 72 676 Td (Consulting and installation.) Tj ET",
        ]),
    ];
    const objects: string[] = [
        "<< /Type /Catalog /Pages 2 0 R /Outlines 12 0 R >>",
        "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents 6 0 R >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents 7 0 R >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents 8 0 R >>",
        ...contents.map((c) => `<< /Length ${c.length} >>\nstream\n${c}\nendstream`),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        "<< /Title (Fees) /Parent 12 0 R /Next 11 0 R /Dest [4 0 R /XYZ 72 720 0] >>",
        "<< /Title (Schedule 1) /Parent 12 0 R /Prev 10 0 R /Dest [5 0 R /XYZ 72 720 0] >>",
        "<< /Type /Outlines /First 10 0 R /Last 11 0 R /Count 2 >>",
    ];
    let pdf = "%PDF-1.7\n";
    const offsets: number[] = [];
    for (const [index, object] of objects.entries()) {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = Buffer.from(pdf, "latin1");
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("PDF", () => {
    it("rebuilds paragraphs and headings, drops running headers and page numbers, and trusts bookmarks", async () => {
        const extracted = await extractPdfPages(buildPdf());
        expect(extracted.outline).toEqual([
            { title: "Fees", depth: 1, page: 2 },
            { title: "Schedule 1", depth: 1, page: 3 },
        ]);
        const model = pdfToModel(extracted);
        expect(model.pages).toBe(3);
        expect(shape(model.blocks)).toEqual([
            ["p1.1", "heading", 1, null, "MASTER SERVICES AGREEMENT"],
            ["p1.2", "heading", 2, "1.", "1. Definitions"],
            ["p1.3", "paragraph", null, null, "In this Agreement the following words have the meanings set out below."],
            ["p1.4", "paragraph", null, "1.1", "1.1 Services means the work in Schedule 1."],
            ["p1.5", "list_item", 1, "(a)", "(a) including support."],
            ["p2.1", "heading", 1, "2.", "2. Fees"],
            ["p2.2", "paragraph", null, null, "The Customer pays the fees within thirty days."],
            ["p3.1", "heading", 1, null, "SCHEDULE 1"],
            ["p3.2", "paragraph", null, null, "Consulting and installation."],
        ]);
        // Headings found by size are guesses; the bookmarked ones are not.
        expect(model.blocks[0].inferred).toBe(true);
        expect(model.blocks[5].inferred).toBeUndefined();
        expect(model.blocks[7].inferred).toBeUndefined();
        expect(model.warnings.join(" ")).toContain("6 repeated page header, footer and page-number lines were left out.");
    });

    it("marks OCR text and keeps a scanned page that has not been read", () => {
        const model = pdfToModel({
            outline: [],
            pages: [
                { number: 1, lines: [], ocrText: "Recovered words.\n\nSecond paragraph.", ocrPending: false, fields: [] },
                { number: 2, lines: [], ocrPending: true, fields: ["Case number: 24-CV-1"] },
            ],
        });
        expect(model.blocks.map((b) => [b.id, b.kind, b.text, b.ocr ?? false])).toEqual([
            ["p1.1", "paragraph", "Recovered words.", true],
            ["p1.2", "paragraph", "Second paragraph.", true],
            ["p2.1", "figure", "[Scanned page: its text has not been recovered yet]", false],
            ["p2.2", "paragraph", "[Form field] Case number: 24-CV-1", false],
        ]);
        expect(model.warnings).toContain("Scanned pages awaiting OCR: 2.");
    });
});

describe("spreadsheet", () => {
    it("gives each sheet a heading and one table of display values with its range", () => {
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet([[], [null, "Item", "Fee"], [null, "Setup", 2000], [null, "Monthly", 500]]);
        ws.C3.z = "$#,##0";
        XLSX.utils.book_append_sheet(wb, ws, "Fees");
        const model = spreadsheetToModel(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
        expect(model.blocks.map((b) => [b.id, b.kind, b.source])).toEqual([
            ["s1.h", "heading", "Fees!"],
            ["s1", "table", "Fees!B2:C4"],
        ]);
        expect(model.blocks[1].rows).toEqual([["Item", "Fee"], ["Setup", "$2,000"], ["Monthly", "500"]]);
    });
});

describe("presentation", () => {
    it("reads slide titles, bullets, tables and speaker notes", async () => {
        const zip = new JSZip();
        const sp = (body: string, ph?: string) =>
            `<p:sp><p:nvSpPr><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ""}</p:nvPr></p:nvSpPr><p:txBody>${body}</p:txBody></p:sp>`;
        const p = (text: string, extra = "") => `<a:p>${extra}<a:r><a:t>${text}</a:t></a:r></a:p>`;
        zip.file(
            "ppt/slides/slide1.xml",
            `<p:sld><p:cSld><p:spTree>${sp(p("Private AI &amp; the firm"), "title")}${sp(
                p("Why now", '<a:pPr lvl="0"><a:buChar char="•"/></a:pPr>') + p("Costs fell", '<a:pPr lvl="1"/>'),
            )}<p:graphicFrame><a:tbl><a:tr><a:tc>${p("Tier")}</a:tc><a:tc>${p("Price")}</a:tc></a:tr></a:tbl></p:graphicFrame></p:spTree></p:cSld></p:sld>`,
        );
        zip.file("ppt/slides/_rels/slide1.xml.rels", `<Relationships><Relationship Target="../notesSlides/notesSlide1.xml"/></Relationships>`);
        zip.file("ppt/notesSlides/notesSlide1.xml", `<p:notes>${sp(p("Mention the pilot."), "body")}</p:notes>`);
        zip.file("ppt/slides/slide2.xml", `<p:sld><p:cSld><p:spTree>${sp(p("Untitled body"))}</p:spTree></p:cSld></p:sld>`);
        const model = await presentationToModel(await zip.generateAsync({ type: "nodebuffer" }));
        expect(model.pages).toBe(2);
        expect(model.blocks.map((b) => [b.id, b.kind, b.level ?? null, b.text, b.page])).toEqual([
            ["s1.0", "heading", 1, "Private AI & the firm", 1],
            ["s1.1", "list_item", 1, "Why now", 1],
            ["s1.2", "list_item", 2, "Costs fell", 1],
            ["s1.3", "table", null, "Tier | Price", 1],
            ["s1.4", "note", null, "Mention the pilot.", 1],
            ["s2.0", "heading", 1, "Slide 2", 2],
            ["s2.1", "paragraph", null, "Untitled body", 2],
        ]);
    });
});
