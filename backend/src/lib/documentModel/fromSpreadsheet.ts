import * as XLSX from "xlsx";
import type { DocBlock, DocumentModel } from "./types";

// A workbook into the common model: per sheet, a heading with its name and
// one table of display values (cell.w: dates and currency as a person sees
// them; formulas never shown). The table's `source` names its range, e.g.
// "Q3 Budget!A1:F40", so a cell is addressed by its row and column from
// that origin. Empty rows and columns at the edges are trimmed.

const MAX_ROWS_PER_SHEET = 5_000;

const display = (cell: XLSX.CellObject | undefined) =>
    !cell ? "" : typeof cell.w === "string" && cell.w ? cell.w : cell.v == null ? "" : String(cell.v);

export function spreadsheetToModel(buffer: Buffer): DocumentModel {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const blocks: DocBlock[] = [];
    const warnings: string[] = [];
    wb.SheetNames.forEach((name, index) => {
        const ws = wb.Sheets[name];
        const ref = ws?.["!ref"];
        if (!ws || !ref) return;
        const range = XLSX.utils.decode_range(ref);
        let top = range.e.r + 1;
        let bottom = -1;
        let left = range.e.c + 1;
        let right = -1;
        for (let r = range.s.r; r <= range.e.r; r++) {
            for (let c = range.s.c; c <= range.e.c; c++) {
                if (!display(ws[XLSX.utils.encode_cell({ r, c })]).trim()) continue;
                top = Math.min(top, r);
                bottom = Math.max(bottom, r);
                left = Math.min(left, c);
                right = Math.max(right, c);
            }
        }
        if (bottom < 0) return;
        const last = Math.min(bottom, top + MAX_ROWS_PER_SHEET - 1);
        if (last < bottom) warnings.push(`Sheet "${name}" has ${bottom - top + 1} rows; the first ${MAX_ROWS_PER_SHEET} are here.`);
        const rows: string[][] = [];
        for (let r = top; r <= last; r++) {
            const row: string[] = [];
            for (let c = left; c <= right; c++) row.push(display(ws[XLSX.utils.encode_cell({ r, c })]).replace(/\r?\n/g, " ").trim());
            rows.push(row);
        }
        const area = XLSX.utils.encode_range({ s: { r: top, c: left }, e: { r: last, c: right } });
        blocks.push({ id: `s${index + 1}.h`, kind: "heading", level: 1, text: name, source: `${name}!` });
        blocks.push({
            id: `s${index + 1}`,
            kind: "table",
            text: rows.map((row) => row.join(" | ")).join("\n"),
            rows,
            source: `${name}!${area}`,
        });
    });
    return { format: "spreadsheet", blocks, warnings };
}
