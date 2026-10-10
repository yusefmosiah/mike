import { isTitleLike } from "../docx/render";
import type { Block, DocxDocument, ParagraphBlock, TableBlock } from "../docx/view";
import type { DocBlock, DocumentModel } from "./types";

// A .docx through the Mission 1a document view: the block ids are the ones
// read_document and edit_document use, so what is found here can be read
// around and edited by the same id. Pass the view the engine builds
// (documentOps docxView), whose ids carry across versions.

const QUOTE_STYLE = /quote/i;
const TITLE_STYLE = /^(title|subtitle)$/i;

function paragraphBlock(p: ParagraphBlock): DocBlock | null {
    if (p.markRevision === "del") return null;
    const text = p.text.trim();
    if (!text) return null;
    const label = p.fullLabel ?? p.label;
    if (p.styleName && TITLE_STYLE.test(p.styleName)) {
        return { id: p.id, kind: "heading", level: /sub/i.test(p.styleName) ? 2 : 1, text };
    }
    if (p.outlineLevel !== undefined && isTitleLike(p)) {
        return { id: p.id, kind: "heading", level: p.outlineLevel + 1, text, ...(label ? { label } : {}) };
    }
    if (p.styleName && QUOTE_STYLE.test(p.styleName)) return { id: p.id, kind: "quote", text };
    if (p.listLevel !== undefined || p.isBullet) {
        return {
            id: p.id,
            kind: "list_item",
            level: (p.listLevel ?? 0) + 1,
            ...(label && !p.isBullet ? { label } : {}),
            text,
        };
    }
    return { id: p.id, kind: "paragraph", text, ...(label ? { label } : {}) };
}

function tableBlock(t: TableBlock): DocBlock {
    const rows = t.rows
        .filter((row) => row.revision !== "del")
        .map((row) =>
            row.cells
                .filter((cell) => cell.vMerge !== "continue")
                .map((cell) =>
                    cell.blocks
                        .map((b) => (b.kind === "paragraph" && b.markRevision !== "del" ? b.text.trim() : ""))
                        .filter(Boolean)
                        .join("\n"),
                ),
        );
    return { id: t.id, kind: "table", text: rows.map((row) => row.join(" | ")).join("\n"), rows };
}

function block(b: Block): DocBlock | null {
    if (b.kind === "paragraph") return paragraphBlock(b);
    if (b.kind === "table") return tableBlock(b);
    return { id: b.id, kind: "figure", text: `[${b.name}]` };
}

export function docxToModel(doc: DocxDocument): DocumentModel {
    const blocks: DocBlock[] = [];
    for (const b of doc.blocks) {
        const converted = block(b);
        if (converted) blocks.push(converted);
    }
    // Footnotes and endnotes follow the body, each paragraph a note block
    // labelled with the mark the reader sees.
    for (const notes of [doc.footnotes, doc.endnotes]) {
        for (const note of notes.values()) {
            for (const p of note.paragraphs) {
                const text = p.text.trim();
                if (text) blocks.push({ id: p.id, kind: "note", label: note.mark, text, source: note.kind });
            }
        }
    }
    return { format: "docx", blocks, warnings: [] };
}
