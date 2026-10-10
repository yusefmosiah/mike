import type { DocBlock, DocumentModel } from "./types";

// Markdown and plain text into the common model. A small block-level reader
// rather than a dependency: the model needs headings, lists, code, quotes,
// tables and paragraphs with their source lines, not inline rendering.
// Ids are `m<first line>`, stable for the text.

const FENCE = /^(\s{0,3})(```+|~~~+)\s*([\w+-]*)/;
const ATX = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const SETEXT = /^\s{0,3}(=+|-+)\s*$/;
const LIST = /^(\s*)([-*+]|(\d{1,9}|[a-zA-Z]|[ivxlcdmIVXLCDM]+)[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const THEMATIC_BREAK = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const cells = (line: string) =>
    line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replace(/\\\|/g, "|"));

const span = (start: number, end: number) => (start === end ? `line ${start}` : `lines ${start}-${end}`);

export function markdownToModel(source: string): DocumentModel {
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    const blocks: DocBlock[] = [];
    let i = 0;
    const push = (block: Omit<DocBlock, "id" | "source">, first: number, last: number) =>
        blocks.push({ id: `m${first + 1}`, ...block, source: span(first + 1, last + 1) });

    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim() || THEMATIC_BREAK.test(line)) {
            i++;
            continue;
        }
        const fence = FENCE.exec(line);
        if (fence) {
            const marker = fence[2];
            const start = i;
            const body: string[] = [];
            i++;
            while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
            const end = Math.min(i, lines.length - 1);
            i++;
            push({ kind: "code", text: body.join("\n"), ...(fence[3] ? { language: fence[3] } : {}) }, start, end);
            continue;
        }
        const atx = ATX.exec(line);
        if (atx) {
            push({ kind: "heading", level: atx[1].length, text: atx[2] }, i, i);
            i++;
            continue;
        }
        const next = lines[i + 1];
        if (next !== undefined && SETEXT.test(next) && !LIST.test(line) && !QUOTE.test(line)) {
            push({ kind: "heading", level: next.trim().startsWith("=") ? 1 : 2, text: line.trim() }, i, i + 1);
            i += 2;
            continue;
        }
        if (line.includes("|") && next !== undefined && TABLE_RULE.test(next)) {
            const start = i;
            const rows = [cells(line)];
            i += 2;
            while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
            push({ kind: "table", text: rows.map((row) => row.join(" | ")).join("\n"), rows }, start, i - 1);
            continue;
        }
        const quote = QUOTE.exec(line);
        if (quote) {
            const start = i;
            const body: string[] = [];
            while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])![1]);
            push({ kind: "quote", text: body.join("\n").trim() }, start, i - 1);
            continue;
        }
        const item = LIST.exec(line);
        if (item) {
            const start = i;
            const text = [item[4]];
            i++;
            // Continuation lines: indented and not a new item or block.
            while (
                i < lines.length &&
                lines[i].trim() &&
                /^\s{2,}/.test(lines[i]) &&
                !LIST.test(lines[i]) &&
                !FENCE.test(lines[i])
            ) {
                text.push(lines[i++].trim());
            }
            const ordered = item[3] !== undefined;
            push(
                {
                    kind: "list_item",
                    level: Math.floor(item[1].replace(/\t/g, "    ").length / 2) + 1,
                    ...(ordered ? { label: item[2] } : {}),
                    text: text.join(" "),
                },
                start,
                i - 1,
            );
            continue;
        }
        // A paragraph runs until a blank line or the start of another block.
        const start = i;
        const text = [line.trim()];
        i++;
        while (
            i < lines.length &&
            lines[i].trim() &&
            !ATX.test(lines[i]) &&
            !FENCE.test(lines[i]) &&
            !QUOTE.test(lines[i]) &&
            !LIST.test(lines[i]) &&
            !(lines[i + 1] !== undefined && SETEXT.test(lines[i + 1]) && lines[i + 1].trim().startsWith("="))
        ) {
            if (SETEXT.test(lines[i])) break;
            text.push(lines[i++].trim());
        }
        push({ kind: "paragraph", text: text.join(" ") }, start, i - 1);
    }
    return { format: "markdown", blocks, warnings: [] };
}

/** Plain text: paragraphs separated by blank lines, nothing inferred. */
export function textToModel(source: string): DocumentModel {
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    const blocks: DocBlock[] = [];
    let i = 0;
    while (i < lines.length) {
        if (!lines[i].trim()) {
            i++;
            continue;
        }
        const start = i;
        const text: string[] = [];
        while (i < lines.length && lines[i].trim()) text.push(lines[i++].trim());
        blocks.push({ id: `m${start + 1}`, kind: "paragraph", text: text.join("\n"), source: span(start + 1, i) });
    }
    return { format: "text", blocks, warnings: [] };
}
