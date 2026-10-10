import type { PdfLine, PdfOutlineEntry, PdfPageLines } from "../pdfText";
import type { DocBlock, DocumentModel } from "./types";

// A PDF into the common model. A PDF has no structure of its own beyond
// positioned text, so the structure here is reconstructed, and the model
// says so:
//
//   - lines come from pdfText.pageLines, in the reading order citation
//     highlighting also uses (columns first, then baselines);
//   - running headers and footers, a line repeated at the top or bottom of
//     most pages, are left out (Docling calls this "furniture");
//   - lines join into paragraphs by their spacing and type size;
//   - a short paragraph set larger than the body text is a heading, marked
//     `inferred`; so is a short all-capitals line, common for legal
//     headings set in the body size;
//   - the PDF's own bookmarks, when it has them, name real headings: a
//     matching paragraph becomes a heading that is not inferred;
//   - clause numbers ("12.3") and list markers ("(a)", "•") become labels;
//   - a scanned page's OCR text is marked `ocr`, and a page whose OCR has
//     not run is a visible placeholder, never silently empty.
//
// Ids are `p<page>.<n>`. Text is joined with single spaces and never
// de-hyphenated, so a quote taken from a block still matches the extracted
// text citation verification reads.

const HEADING_SIZE_RATIO = 1.15;
const MAX_HEADING_CHARS = 150;
const BULLET = /^([•●▪◦‣∙·–—-])\s+/;
const CLAUSE = /^(§\s*)?((?:\d{1,3}\.)+\d{0,3}|\d{1,3}\))\s+(?=\S)/;
const LIST_LABEL = /^(\([a-zA-Z0-9]{1,4}\)|[a-z]\)|(?:[ivxlcdm]{1,6}|[A-Z])\.)\s+(?=\S)/;
const PAGE_NUMBER = /^(page\s+)?[-–—]?\s*\d{1,4}\s*[-–—]?(\s+of\s+\d{1,4})?$/i;

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
const furnitureKey = (text: string) => normalize(text).replace(/\d+/g, "#");

type Paragraph = { lines: PdfLine[]; text: string; size: number };

/** Lines repeated at the top or bottom of most pages, and bare page numbers. */
function furniture(pages: PdfPageLines[]): Set<string> {
    const counts = new Map<string, number>();
    for (const page of pages) {
        const lines = page.lines.filter((line) => line.text.trim());
        const zone = new Set([...lines.slice(0, 2), ...lines.slice(-2)].map((line) => furnitureKey(line.text)));
        for (const key of zone) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const threshold = Math.max(3, Math.ceil(pages.length * 0.4));
    return new Set([...counts].filter(([, n]) => n >= threshold && pages.length >= 3).map(([key]) => key));
}

/** The body type size: the median line height, weighted by characters. */
function bodySize(lines: PdfLine[]): number {
    const sized = lines.filter((line) => line.text.trim()).map((line) => ({ h: line.h, n: line.text.length }));
    if (!sized.length) return 10;
    sized.sort((a, b) => a.h - b.h);
    const total = sized.reduce((sum, line) => sum + line.n, 0);
    let seen = 0;
    for (const line of sized) {
        seen += line.n;
        if (seen >= total / 2) return line.h;
    }
    return sized[sized.length - 1].h;
}

function startsNewParagraph(prev: PdfLine, line: PdfLine, body: number): boolean {
    const gap = prev.y - line.y;
    const height = Math.max(prev.h, line.h);
    if (gap <= 0 || gap > height * 1.7) return true; // a new column, or a blank line between
    if (Math.abs(prev.h - line.h) > height * 0.2) return true; // a change of type size
    if (prev.wide !== line.wide) return true;
    if (prev.h >= body * HEADING_SIZE_RATIO) return true; // a heading stands alone
    const text = line.text.trim();
    return BULLET.test(text) || CLAUSE.test(text) || LIST_LABEL.test(text);
}

function paragraphs(lines: PdfLine[], body: number): Paragraph[] {
    const out: Paragraph[] = [];
    let current: PdfLine[] = [];
    const flush = () => {
        if (!current.length) return;
        const text = current.map((line) => line.text.trim()).filter(Boolean).join(" ");
        if (text) out.push({ lines: current, text, size: Math.max(...current.map((line) => line.h)) });
        current = [];
    };
    for (const line of lines) {
        if (!line.text.trim()) continue;
        if (current.length && startsNewParagraph(current[current.length - 1], line, body)) flush();
        current.push(line);
    }
    flush();
    return out;
}

function isAllCapsHeading(p: Paragraph): boolean {
    if (p.lines.length > 2 || p.text.length > 100) return false;
    const letters = p.text.replace(/[^A-Za-z]/g, "");
    if (letters.length < 4) return false;
    const upper = letters.replace(/[^A-Z]/g, "").length;
    return upper / letters.length >= 0.9 && !/[.;,]$/.test(p.text.trim());
}

function classify(p: Paragraph, body: number, headingLevels: Map<number, number>): Omit<DocBlock, "id" | "page"> {
    const text = p.text;
    const sizeKey = Math.round(p.size * 2) / 2;
    if (p.size >= body * HEADING_SIZE_RATIO && text.length <= MAX_HEADING_CHARS && p.lines.length <= 3) {
        const clause = CLAUSE.exec(text);
        return {
            kind: "heading",
            level: headingLevels.get(sizeKey) ?? 1,
            text,
            inferred: true,
            ...(clause ? { label: clause[2] } : {}),
        };
    }
    if (isAllCapsHeading(p)) {
        const clause = CLAUSE.exec(text);
        return {
            kind: "heading",
            level: Math.min(4, headingLevels.size + 1),
            text,
            inferred: true,
            ...(clause ? { label: clause[2] } : {}),
        };
    }
    if (p.lines.every((line) => line.wide) && p.lines.length >= 2) {
        const rows = p.lines.map((line) => line.text.trim().split(/\s{4,}/));
        return { kind: "table", text: rows.map((row) => row.join(" | ")).join("\n"), rows, inferred: true };
    }
    const bullet = BULLET.exec(text);
    if (bullet) return { kind: "list_item", level: 1, text };
    const list = LIST_LABEL.exec(text);
    if (list) return { kind: "list_item", level: 1, label: list[1], text };
    const clause = CLAUSE.exec(text);
    if (clause) return { kind: "paragraph", label: clause[2], text };
    return { kind: "paragraph", text };
}

/** Bookmarks name real headings: mark the paragraph each one points at. */
function applyOutline(blocks: DocBlock[], outline: PdfOutlineEntry[]): number {
    let matched = 0;
    for (const entry of outline) {
        if (entry.page === null) continue;
        const title = normalize(entry.title);
        if (!title) continue;
        // Bookmarks often leave out the clause number the text shows ("Fees" for "2. Fees").
        const matches = (text: string) =>
            text.startsWith(title) || (text.length <= MAX_HEADING_CHARS && title.startsWith(text));
        const target = blocks.find(
            (block) =>
                block.page !== undefined &&
                block.page >= entry.page! &&
                block.page <= entry.page! + 1 &&
                block.kind !== "table" &&
                (matches(normalize(block.text)) || matches(normalize(block.text.replace(CLAUSE, "")))),
        );
        if (!target) continue;
        target.kind = "heading";
        target.level = Math.min(6, entry.depth);
        delete target.inferred;
        matched++;
    }
    return matched;
}

export function pdfToModel(input: { pages: PdfPageLines[]; outline: PdfOutlineEntry[] }): DocumentModel {
    const { pages, outline } = input;
    const warnings: string[] = [];
    const repeated = furniture(pages);
    let dropped = 0;
    const kept = pages.map((page) => {
        const lines = page.lines.filter((line, index, all) => {
            const text = line.text.trim();
            if (!text) return false;
            const nearEdge = index < 2 || index >= all.length - 2;
            if (nearEdge && (repeated.has(furnitureKey(text)) || PAGE_NUMBER.test(text))) {
                dropped++;
                return false;
            }
            return true;
        });
        return { page, lines };
    });
    if (dropped) warnings.push(`${dropped} repeated page header, footer and page-number lines were left out.`);

    const body = bodySize(kept.flatMap(({ lines }) => lines));
    const perPage = kept.map(({ page, lines }) => ({ page, paragraphs: paragraphs(lines, body) }));
    // Heading levels by type size: the largest size above the body is level 1.
    const sizes = [
        ...new Set(
            perPage
                .flatMap(({ paragraphs: ps }) => ps)
                .filter((p) => p.size >= body * HEADING_SIZE_RATIO && p.text.length <= MAX_HEADING_CHARS)
                .map((p) => Math.round(p.size * 2) / 2),
        ),
    ].sort((a, b) => b - a);
    const headingLevels = new Map(sizes.slice(0, 4).map((size, index) => [size, index + 1]));
    for (const size of sizes.slice(4)) headingLevels.set(size, 4);

    const blocks: DocBlock[] = [];
    const pending: number[] = [];
    for (const { page, paragraphs: ps } of perPage) {
        let n = 0;
        const id = () => `p${page.number}.${++n}`;
        for (const p of ps) blocks.push({ id: id(), page: page.number, ...classify(p, body, headingLevels) });
        if (page.ocrText) {
            for (const chunk of page.ocrText.split(/\n\s*\n/)) {
                const text = chunk.replace(/\s+/g, " ").trim();
                if (text) blocks.push({ id: id(), page: page.number, kind: "paragraph", text, ocr: true });
            }
        } else if (page.ocrPending) {
            pending.push(page.number);
            blocks.push({
                id: id(),
                page: page.number,
                kind: "figure",
                text: "[Scanned page: its text has not been recovered yet]",
            });
        }
        for (const field of page.fields) {
            blocks.push({ id: id(), page: page.number, kind: "paragraph", text: `[Form field] ${field}` });
        }
    }
    if (pending.length) warnings.push(`Scanned pages awaiting OCR: ${pending.join(", ")}.`);
    const matched = applyOutline(blocks, outline);
    if (outline.length && matched < outline.length) {
        warnings.push(`${outline.length - matched} of the PDF's ${outline.length} bookmarks did not match a heading in the text.`);
    }
    if (blocks.some((block) => block.inferred && block.kind === "heading")) {
        warnings.push("Some headings were recognised by their type size or capitals; they are marked inferred.");
    }
    return { format: "pdf", blocks, pages: pages.length, warnings };
}
