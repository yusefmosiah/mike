// Segmented reading for .docx, the way a coding agent reads a repository:
// an outline and a bounded window by default, a section or block range on
// request, and the whole document only when asked for explicitly.

import {
  DEFAULT_WINDOW_CHARS,
  blockIndex,
  findSections,
  outline,
  renderWindow,
  type RenderedWindow,
} from "./render";
import type { DocxDocument } from "./view";

export interface DocxReadRequest {
  /** Clause number or heading, e.g. "16", "5.3.1(a)", "Schedule 2". */
  section?: string;
  /** Block id to start at (from an outline, a find hit, or a continuation notice). */
  from?: string;
  /** Block id to stop after (inclusive). */
  to?: string;
  /** Return the whole document (capped at FULL_READ_MAX_CHARS). */
  full?: boolean;
  /** Window size in characters (default DEFAULT_WINDOW_CHARS). */
  maxChars?: number;
}

export interface DocxReadResult {
  text: string;
  /** True when the whole document was returned. */
  complete: boolean;
}

/** Hard ceiling for a full read: the model's context is finite even when asked. */
export const FULL_READ_MAX_CHARS = 300_000;
const OUTLINE_MAX_ENTRIES = 200;

export const DOCX_READ_LEGEND =
  "Format: one block per line, [id] first. Labels are clause numbers. " +
  "[^n] footnote (its text after the window, with its own block id), {ref 4.2} live cross-reference, " +
  "[text](url) link, {++text++}/{--text--} tracked insertion/deletion, " +
  "{image}/{equation}/{textbox: …} non-text content, " +
  "rNcM table cell. Tokens are not document text.";

export function renderDocxRead(doc: DocxDocument, req: DocxReadRequest = {}): DocxReadResult {
  const total = doc.blocks.length;
  const chars = doc.paragraphs.reduce((n, p) => n + p.text.length + 1, 0);
  const summary = `Document: ${total} blocks (${doc.paragraphs.length} paragraphs), about ${chars.toLocaleString("en-US")} characters.`;

  if (req.full) {
    const w = renderWindow(doc, { maxChars: FULL_READ_MAX_CHARS });
    const complete = w.next >= total;
    return {
      text: [summary, DOCX_READ_LEGEND, "", w.text, continuation(doc, w, complete ? undefined : "full read capped")].filter(Boolean).join("\n"),
      complete,
    };
  }

  if (req.section !== undefined) {
    const matches = findSections(doc, req.section);
    if (matches.length === 0) {
      return {
        text: `${summary}\nNo clause or heading matches "${req.section}". Use find_in_document to search the text, or read_document without arguments for the outline.`,
        complete: false,
      };
    }
    if (matches.length > 1) {
      const list = matches
        .slice(0, 40)
        .map((m) => `- [${m.paragraph.id}] ${m.paragraph.fullLabel ?? m.paragraph.label ?? ""} ${m.paragraph.text.trim().slice(0, 80)}${m.within ? ` (in ${m.within})` : ""}`)
        .join("\n");
      return {
        text: `${summary}\n"${req.section}" matches ${matches.length} sections${matches.length > 40 ? " (first 40 shown)" : ""}. Read one with from: "<id>":\n${list}`,
        complete: false,
      };
    }
    const m = matches[0];
    const w = renderWindow(doc, { start: m.start, end: m.end, maxChars: req.maxChars });
    const endedEarly = w.next < m.end;
    return {
      text: [summary, "", w.text, endedEarly ? continuation(doc, w, `section continues; stop with to: "${lastId(doc, m.end)}"`) : `[End of section ${req.section}.]`].join("\n"),
      complete: m.start === 0 && w.next >= total,
    };
  }

  if (req.from !== undefined || req.to !== undefined) {
    const start = req.from !== undefined ? blockIndex(doc, req.from) : 0;
    const endInclusive = req.to !== undefined ? blockIndex(doc, req.to) : total - 1;
    const unknown = [start === undefined ? req.from : undefined, endInclusive === undefined ? req.to : undefined].filter(Boolean);
    if (unknown.length) {
      return {
        text: `${summary}\nUnknown block id ${unknown.map((u) => `"${u}"`).join(" and ")}. Block ids come from read_document or find_in_document results for this document version.`,
        complete: false,
      };
    }
    const w = renderWindow(doc, { start, end: endInclusive! + 1, maxChars: req.maxChars });
    const reachedEnd = w.next >= endInclusive! + 1;
    return {
      text: [summary, "", w.text, reachedEnd ? (w.next >= total ? "[End of document.]" : "") : continuation(doc, w)].filter((s) => s !== "").join("\n"),
      complete: start === 0 && w.next >= total,
    };
  }

  // Default: everything when it fits, otherwise outline plus the first window.
  const first = renderWindow(doc, { maxChars: req.maxChars ?? DEFAULT_WINDOW_CHARS });
  if (first.next >= total) {
    return { text: [summary, DOCX_READ_LEGEND, "", first.text].join("\n"), complete: true };
  }
  const entries = outline(doc);
  const outlineText = entries.length
    ? [
        `Outline (${entries.length} headings${entries.length > OUTLINE_MAX_ENTRIES ? `, first ${OUTLINE_MAX_ENTRIES} shown` : ""}):`,
        ...entries.slice(0, OUTLINE_MAX_ENTRIES).map((e) => `${"  ".repeat(e.level)}[${e.id}] ${e.label ? `${e.label} ` : ""}${e.title}`),
      ].join("\n")
    : "Outline: no headings detected.";
  return {
    text: [
      summary,
      DOCX_READ_LEGEND,
      "Read more with section: \"<clause or heading>\", from/to: \"<block id>\", or find_in_document. full: true returns everything.",
      "",
      outlineText,
      "",
      first.text,
      continuation(doc, first),
    ].join("\n"),
    complete: false,
  };
}

function lastId(doc: DocxDocument, endExclusive: number): string {
  return doc.blocks[Math.max(0, endExclusive - 1)].id;
}

function continuation(doc: DocxDocument, w: RenderedWindow, note?: string): string {
  if (w.next >= w.total) return "[End of document.]";
  const nextId = doc.blocks[w.next].id;
  return `[Showing blocks ${w.start + 1}–${w.next} of ${w.total}${note ? `; ${note}` : ""}. Continue with read_document from: "${nextId}".]`;
}
