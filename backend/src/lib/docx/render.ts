// Model-facing rendering of the document view, and segmented reading.
//
// Each block renders on its own line, prefixed by its ID in brackets, the way
// a coding agent sees line numbers:
//
//   [0000029E] ## 16. Intellectual Property Rights
//   [0000029F] 16.1 The Supplier shall{++ not++} ... Clause {ref 17.2}[^3]
//
// Inline tokens make non-text content visible instead of dropping it:
//   [^3]               footnote/endnote reference (note text listed after the window)
//   {ref 17.2}         a cross-reference field showing its current result
//   [text](url)        hyperlink
//   {++text++}         tracked insertion; {--text--} tracked deletion
//   {image} {equation} {textbox: ...} {symbol Font F0xx} {comment 4}
// Labels are full-context clause numbers ("5.3.1(a)"), the form lawyers and
// cross-references use.

import type { Block, DocxDocument, Inline, Note, ParagraphBlock, TableBlock } from "./view";

export interface RenderOptions {
  /** Show tracked changes as CriticMarkup (default true). */
  markup?: boolean;
}

export function renderInlines(inlines: readonly Inline[], opts: RenderOptions = {}): string {
  const markup = opts.markup ?? true;
  let s = "";
  for (const inline of inlines) {
    switch (inline.t) {
      case "text":
        s += inline.text;
        break;
      case "tab":
        s += "\t";
        break;
      case "break":
        s += inline.kind === "page" ? " {page break} " : "\n";
        break;
      case "note":
        s += inline.kind === "footnote" ? `[^${inline.mark}]` : `[^e${inline.mark}]`;
        break;
      case "noteMark":
        break;
      case "sym":
        s += inline.char ?? `{symbol ${inline.font ?? "?"} ${inline.code}}`;
        break;
      case "field":
        s += renderField(inline.instr, inline.result, opts);
        break;
      case "link": {
        const text = renderInlines(inline.content, opts);
        s += inline.target ? `[${text}](${inline.target})` : text;
        break;
      }
      case "rev": {
        const text = renderInlines(inline.content, opts);
        const isInsert = inline.kind === "ins" || inline.kind === "moveTo";
        if (!markup) s += isInsert ? text : "";
        else if (text) s += isInsert ? `{++${text}++}` : `{--${text}--}`;
        break;
      }
      case "sdt":
        s += renderInlines(inline.content, opts);
        break;
      case "comment":
        s += `{comment ${inline.id}}`;
        break;
      case "object":
        if (inline.textbox) {
          const lines = inline.textbox.map((l) => l.trim()).filter(Boolean);
          s += lines.length ? `{textbox: ${lines.join(" / ")}}` : "{textbox (empty)}";
        } else {
          s += `{${objectName(inline.kind)}}`;
        }
        break;
    }
  }
  return s;
}

function objectName(kind: string): string {
  switch (kind) {
    case "drawing":
    case "pict":
    case "alternateContent":
      return "image";
    case "math":
      return "equation";
    case "object":
      return "embedded object";
    default:
      return kind.replace(/^\w+:/, "");
  }
}

function renderField(instr: string, result: readonly Inline[], opts: RenderOptions): string {
  const text = renderInlines(result, opts);
  const name = instr.split(/\s+/)[0]?.toUpperCase() ?? "";
  if (name === "REF" || name === "NOTEREF") return `{ref ${text.trim()}}`;
  // Page numbers, TOC entries and hyperlink fields read as their result.
  return text;
}

function headingMarker(p: ParagraphBlock): string {
  if (p.outlineLevel === undefined || !isTitleLike(p)) return "";
  return `${"#".repeat(Math.min(p.outlineLevel + 1, 6))} `;
}

/**
 * A title rather than a body clause that happens to carry an outline level
 * (legal templates give every clause one): short, and either unpunctuated at
 * the end or only a few words ("Article 4. Financial Obligations.").
 */
function isTitleLike(p: ParagraphBlock): boolean {
  const t = p.text.trim();
  if (t.length === 0 || t.length > 120) return false;
  if (!/[.;:,]$/.test(t)) return true;
  return t.split(/\s+/).length <= 6;
}

export function renderParagraph(p: ParagraphBlock, opts: RenderOptions = {}): string {
  const label = p.fullLabel ?? p.label;
  const parts = [`[${p.id}]`];
  const heading = headingMarker(p);
  if (heading) parts.push(heading.trim());
  if (label) parts.push(label);
  let line = parts.join(" ");
  const body = renderInlines(p.inlines, opts);
  if (body) line += ` ${body}`;
  if (p.markRevision === "del") line += " {--¶--}";
  if (p.markRevision === "ins") line += " {++¶++}";
  if (p.sectionBreak) line += " {section break}";
  return line;
}

export function renderTable(t: TableBlock, opts: RenderOptions = {}): string[] {
  const cols = Math.max(0, ...t.rows.map((r) => r.cells.reduce((n, c) => n + c.gridSpan, 0)));
  const lines = [`[${t.id}] {table ${t.rows.length} rows × ${cols} columns}`];
  t.rows.forEach((row, r) => {
    const rowMark = row.revision === "ins" ? " {++row++}" : row.revision === "del" ? " {--row--}" : "";
    row.cells.forEach((cell, c) => {
      if (cell.vMerge === "continue") return;
      const where = `  r${r + 1}c${c + 1}${rowMark}`;
      for (const block of cell.blocks) {
        for (const line of renderBlock(block, opts)) lines.push(`${where} ${line}`);
      }
    });
  });
  return lines;
}

export function renderBlock(b: Block, opts: RenderOptions = {}): string[] {
  if (b.kind === "paragraph") return [renderParagraph(b, opts)];
  if (b.kind === "table") return renderTable(b, opts);
  return [`[${b.id}] {${b.name.replace(/^\w+:/, "")}}`];
}

// ---------------------------------------------------------------------------
// Outline and sections
// ---------------------------------------------------------------------------

export interface OutlineEntry {
  id: string;
  index: number;
  level: number;
  label?: string;
  title: string;
}

/**
 * Headings for navigation: title-like paragraphs at the two shallowest
 * outline levels the document uses. Body clauses that carry an outline level
 * (common in legal templates) are left out by the title test.
 */
export function outline(doc: DocxDocument): OutlineEntry[] {
  const index = topLevelIndex(doc);
  const candidates = doc.blocks.filter(
    (b): b is ParagraphBlock => b.kind === "paragraph" && b.outlineLevel !== undefined && isTitleLike(b),
  );
  const levels = [...new Set(candidates.map((p) => p.outlineLevel!))].sort((a, b) => a - b).slice(0, 2);
  return candidates
    .filter((p) => levels.includes(p.outlineLevel!))
    .map((p) => ({
      id: p.id,
      index: index.get(p.id)!,
      level: levels.indexOf(p.outlineLevel!),
      label: p.fullLabel ?? p.label,
      title: p.text.trim(),
    }));
}

function topLevelIndex(doc: DocxDocument): Map<string, number> {
  const map = new Map<string, number>();
  doc.blocks.forEach((b, i) => map.set(b.id, i));
  return map;
}

/** The top-level block index containing a block id (paragraphs in tables map to their table). */
export function blockIndex(doc: DocxDocument, id: string): number | undefined {
  const direct = doc.blocks.findIndex((b) => b.id === id);
  if (direct !== -1) return direct;
  const target = doc.byId.get(id);
  if (target?.kind === "paragraph" && target.cell) {
    return doc.blocks.findIndex((b) => b.id === target.cell!.tableId);
  }
  return undefined;
}

const normalizeLabel = (s: string) => s.replace(/\s+/g, "").replace(/[.]+$/, "").toLowerCase();

export interface SectionMatch {
  start: number;
  end: number;
  paragraph: ParagraphBlock;
  /** Nearest enclosing title above it, to tell repeated labels apart. */
  within?: string;
}

/**
 * Find a section by clause label ("16", "16.1", "5.3.1(a)", "Schedule 2") or
 * by heading text. A section runs until the next paragraph at the same or a
 * shallower outline/list level.
 */
export function findSections(doc: DocxDocument, query: string): SectionMatch[] {
  const q = normalizeLabel(query);
  const blocks = doc.blocks;
  const out: SectionMatch[] = [];
  blocks.forEach((b, i) => {
    if (b.kind !== "paragraph") return;
    const label = b.fullLabel ?? b.label;
    const labelHit = label !== undefined && normalizeLabel(label) === q;
    const titleHit =
      !labelHit &&
      isTitleLike(b) &&
      (normalizeLabel(b.text) === q || normalizeLabel(`${label ?? ""}${b.text}`) === q);
    if (!labelHit && !titleHit) return;
    out.push({ start: i, end: sectionEnd(blocks, i), paragraph: b, within: enclosingTitle(blocks, i) });
  });
  return out;
}

function depth(p: ParagraphBlock): number | undefined {
  return p.outlineLevel ?? p.listLevel;
}

function sectionEnd(blocks: readonly Block[], start: number): number {
  const head = blocks[start] as ParagraphBlock;
  const d = depth(head);
  if (d === undefined) return start + 1;
  for (let i = start + 1; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== "paragraph") continue;
    const bd = depth(b);
    if (bd !== undefined && bd <= d && (b.label !== undefined || b.outlineLevel !== undefined)) return i;
  }
  return blocks.length;
}

function enclosingTitle(blocks: readonly Block[], index: number): string | undefined {
  const head = blocks[index] as ParagraphBlock;
  const d = depth(head) ?? 99;
  for (let i = index - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind !== "paragraph" || b.outlineLevel === undefined || !isTitleLike(b)) continue;
    if (b.outlineLevel < d) return `${b.fullLabel ? `${b.fullLabel} ` : ""}${b.text.trim()}`.slice(0, 120);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Windowed reading
// ---------------------------------------------------------------------------

export const DEFAULT_WINDOW_CHARS = 40_000;

export interface WindowRequest {
  /** First top-level block index (default 0). */
  start?: number;
  /** Exclusive end index; reading also stops at maxChars. */
  end?: number;
  maxChars?: number;
  markup?: boolean;
}

export interface RenderedWindow {
  text: string;
  start: number;
  /** Exclusive index of the first block not shown. */
  next: number;
  total: number;
  /** Notes referenced inside the window, listed after it. */
  notes: Note[];
}

export function renderWindow(doc: DocxDocument, req: WindowRequest = {}): RenderedWindow {
  const total = doc.blocks.length;
  const start = Math.max(0, Math.min(req.start ?? 0, total));
  const end = Math.min(req.end ?? total, total);
  const maxChars = req.maxChars ?? DEFAULT_WINDOW_CHARS;
  const opts = { markup: req.markup };
  const lines: string[] = [];
  let used = 0;
  let i = start;
  for (; i < end; i++) {
    const blockLines = renderBlock(doc.blocks[i], opts);
    const size = blockLines.reduce((n, l) => n + l.length + 1, 0);
    // Always show at least one block, even an oversized one.
    if (used + size > maxChars && i > start) break;
    lines.push(...blockLines);
    used += size;
  }
  const notes = notesIn(doc, start, i);
  if (notes.length) {
    lines.push("");
    for (const n of notes) {
      const body = n.paragraphs.map((p) => renderInlines(p.inlines, opts).trim()).filter(Boolean).join(" / ");
      lines.push(`[^${n.kind === "endnote" ? "e" : ""}${n.mark}]: ${body}`);
    }
  }
  return { text: lines.join("\n"), start, next: i, total, notes };
}

function notesIn(doc: DocxDocument, start: number, end: number): Note[] {
  const out: Note[] = [];
  const seen = new Set<string>();
  const visit = (inlines: readonly Inline[]) => {
    for (const i of inlines) {
      if (i.t === "note") {
        const note = (i.kind === "footnote" ? doc.footnotes : doc.endnotes).get(i.id);
        const key = `${i.kind}:${i.id}`;
        if (note && !seen.has(key)) {
          seen.add(key);
          out.push(note);
        }
      } else if (i.t === "link" || i.t === "rev" || i.t === "sdt") visit(i.content);
      else if (i.t === "field") visit(i.result);
    }
  };
  const visitBlock = (b: Block) => {
    if (b.kind === "paragraph") visit(b.inlines);
    else if (b.kind === "table") for (const r of b.rows) for (const c of r.cells) c.blocks.forEach(visitBlock);
  };
  for (let i = start; i < end; i++) visitBlock(doc.blocks[i]);
  return out;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface FindHit {
  id: string;
  label?: string;
  /** Top-level block index, for reading around the hit. */
  index: number;
  snippet: string;
}

/**
 * Case-insensitive, whitespace-tolerant search over current paragraph text
 * (body, tables and notes). Returns block ids so the caller can read or edit
 * exactly there.
 */
export function findInDocument(
  doc: DocxDocument,
  query: string,
  opts: { maxResults?: number; contextChars?: number } = {},
): { hits: FindHit[]; total: number } {
  const maxResults = opts.maxResults ?? 20;
  const context = opts.contextChars ?? 80;
  const needle = query.trim().replace(/\s+/g, " ").toLowerCase();
  const hits: FindHit[] = [];
  let total = 0;
  if (!needle) return { hits, total };
  const search = (p: ParagraphBlock, index: number) => {
    const hay = p.text.replace(/\s+/g, " ");
    const lower = hay.toLowerCase();
    let at = lower.indexOf(needle);
    while (at !== -1) {
      total++;
      if (hits.length < maxResults) {
        const a = Math.max(0, at - context);
        const b = Math.min(hay.length, at + needle.length + context);
        hits.push({
          id: p.id,
          label: p.fullLabel ?? p.label,
          index,
          snippet: `${a > 0 ? "…" : ""}${hay.slice(a, b)}${b < hay.length ? "…" : ""}`,
        });
      }
      at = lower.indexOf(needle, at + needle.length);
    }
  };
  const top = topLevelIndex(doc);
  for (const p of doc.paragraphs) {
    search(p, top.get(p.id) ?? (p.cell ? top.get(p.cell.tableId) ?? -1 : -1));
  }
  for (const notes of [doc.footnotes, doc.endnotes]) {
    for (const note of notes.values()) for (const p of note.paragraphs) search(p, -1);
  }
  return { hits, total };
}
