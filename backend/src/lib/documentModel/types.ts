// The common reading model (goals/mission-14-document-model.md): every
// format becomes a flat list of blocks with stable ids and provenance, so
// outline, search, slicing and citation work the same for a .docx, a PDF,
// Markdown, a spreadsheet or a deck. Editing stays with each format's own
// layer (the docx AST and edit_document); this model is for reading.

export type DocFormat = "docx" | "pdf" | "markdown" | "text" | "spreadsheet" | "presentation";

export type DocBlockKind =
    | "heading"
    | "paragraph"
    | "list_item"
    | "table"
    | "code"
    | "quote"
    | "note"
    | "figure"
    | "page_break";

export type DocBlock = {
    /** Stable for the document version: what reads, citations and edits name. */
    id: string;
    kind: DocBlockKind;
    /** Heading depth (1 = top) or list depth (1 = outermost). */
    level?: number;
    /** The number as displayed: a clause ("12.3(b)") or list label ("(ii)"). */
    label?: string;
    text: string;
    /** Table cells as display text, row by row. */
    rows?: string[][];
    /** 1-based page (PDF) or slide (presentation). */
    page?: number;
    /** Where the block came from in the native format, e.g. "lines 12-14" or "Sheet1!A1:F40". */
    source?: string;
    /** The text was recovered by OCR, not read from a text layer. */
    ocr?: boolean;
    /** The structure was guessed (a PDF heading recognised by its type size). */
    inferred?: boolean;
    /** Code block language, when the source names one. */
    language?: string;
};

export type DocumentModel = {
    format: DocFormat;
    blocks: DocBlock[];
    /** Pages or slides, when the format has them. */
    pages?: number;
    /** Things the reader should know: pages awaiting OCR, content left out. */
    warnings: string[];
};
