// The addressable view of a .docx: blocks with IDs, inline tokens, and
// computed clause labels, each pointing back at the exact XML it came from.
//
// The view is read-only and lossless in one direction: nothing in the
// source is dropped silently. Elements the view does not interpret become
// `object` tokens (inline) or `opaque` blocks, so a reader always sees that
// something is there.

import { DocxPackage, MAIN_DOCUMENT_PART, REL } from "./package";
import { NumberingDefinitions, NumberingTracker } from "./numbering";
import { readNumPr, StyleSheet } from "./styles";
import {
  childElements,
  documentElement,
  firstChild,
  ownText,
  type XmlElement,
  type XmlSource,
} from "./xmlSource";

export interface Fmt {
  b?: true;
  i?: true;
  u?: true;
  strike?: true;
  caps?: true;
  hidden?: true;
}

export type Inline =
  // `node` is the run child an inline comes from (w:t, w:tab, ...), so an
  // edit can split the run exactly there.
  | { t: "text"; text: string; fmt: Fmt; run: XmlElement; node: XmlElement }
  | { t: "tab"; run: XmlElement; node: XmlElement }
  | { t: "break"; kind: "line" | "page" | "column"; run: XmlElement; node: XmlElement }
  | { t: "note"; kind: "footnote" | "endnote"; id: string; mark: string; run: XmlElement; node: XmlElement }
  | { t: "noteMark"; run: XmlElement; node: XmlElement }
  | {
      t: "sym";
      /** Unicode text when known; undefined for an unmapped symbol-font glyph. */
      char?: string;
      font?: string;
      code: string;
      run: XmlElement;
      node: XmlElement;
    }
  | {
      t: "field";
      instr: string;
      result: Inline[];
      /** Every run child from the begin marker to the end marker (complex fields). */
      nodes?: XmlElement[];
      /** The w:fldSimple element (simple fields). */
      el?: XmlElement;
    }
  | { t: "link"; target?: string; anchor?: string; content: Inline[]; el: XmlElement }
  | {
      t: "rev";
      kind: "ins" | "del" | "moveTo" | "moveFrom";
      author?: string;
      date?: string;
      id?: string;
      content: Inline[];
      el: XmlElement;
    }
  | { t: "sdt"; tag?: string; alias?: string; content: Inline[]; el: XmlElement }
  | { t: "comment"; id: string; run: XmlElement; node: XmlElement }
  | {
      t: "object";
      kind: string;
      el: XmlElement;
      /** Text-box paragraphs inside a drawing, read-only. */
      textbox?: string[];
    };

/** Field markers before folding; never present in a finished view. */
type Marker =
  | { t: "fldBegin"; node: XmlElement }
  | { t: "fldSep"; node: XmlElement }
  | { t: "fldEnd"; node: XmlElement }
  | { t: "instr"; text: string; node: XmlElement };

type Raw = Inline | Marker;

export interface ParagraphBlock {
  kind: "paragraph";
  id: string;
  el: XmlElement;
  /** Part this paragraph lives in. */
  part: string;
  styleId?: string;
  styleName?: string;
  /** List label as displayed, e.g. "(b)"; absent for unnumbered paragraphs. */
  label?: string;
  /** List label in full context, e.g. "12.3(b)". */
  fullLabel?: string;
  listLevel?: number;
  isBullet?: boolean;
  /** Outline level 0-8 for headings (from the paragraph or its style). */
  outlineLevel?: number;
  inlines: Inline[];
  /** Current text: insertions included, deletions excluded, objects omitted. */
  text: string;
  bookmarks: string[];
  sectionBreak: boolean;
  /** The paragraph mark itself is a tracked insertion or deletion. */
  markRevision?: "ins" | "del";
  /** Enclosing table cell, when inside a table. */
  cell?: { tableId: string; row: number; col: number };
}

export interface TableCell {
  el: XmlElement;
  gridSpan: number;
  vMerge?: "restart" | "continue";
  blocks: Block[];
}

export interface TableRow {
  el: XmlElement;
  revision?: "ins" | "del";
  cells: TableCell[];
}

export interface TableBlock {
  kind: "table";
  id: string;
  el: XmlElement;
  part: string;
  rows: TableRow[];
}

export interface OpaqueBlock {
  kind: "opaque";
  id: string;
  el: XmlElement;
  part: string;
  name: string;
}

export type Block = ParagraphBlock | TableBlock | OpaqueBlock;

export interface Note {
  kind: "footnote" | "endnote";
  id: string;
  /** Display mark, e.g. "3" (sequential by first reference). */
  mark: string;
  paragraphs: ParagraphBlock[];
}

// Body-level elements that carry nothing visible.
const INVISIBLE_BLOCK = new Set([
  "w:bookmarkStart",
  "w:bookmarkEnd",
  "w:commentRangeStart",
  "w:commentRangeEnd",
  "w:proofErr",
  "w:permStart",
  "w:permEnd",
  "w:moveFromRangeStart",
  "w:moveFromRangeEnd",
  "w:moveToRangeStart",
  "w:moveToRangeEnd",
  "w:customXmlInsRangeStart",
  "w:customXmlInsRangeEnd",
  "w:customXmlDelRangeStart",
  "w:customXmlDelRangeEnd",
  "w:sectPr",
]);

// Paragraph-level elements that carry nothing visible.
const INVISIBLE_INLINE = new Set([
  "w:pPr",
  "w:bookmarkEnd",
  "w:proofErr",
  "w:permStart",
  "w:permEnd",
  "w:commentRangeStart",
  "w:commentRangeEnd",
  "w:moveFromRangeStart",
  "w:moveFromRangeEnd",
  "w:moveToRangeStart",
  "w:moveToRangeEnd",
  "w:customXmlInsRangeStart",
  "w:customXmlInsRangeEnd",
  "w:customXmlDelRangeStart",
  "w:customXmlDelRangeEnd",
]);

// Run children that carry nothing visible.
const INVISIBLE_RUN_CHILD = new Set([
  "w:rPr",
  "w:lastRenderedPageBreak",
  "w:separator",
  "w:continuationSeparator",
  "w:annotationRef",
]);

// Transparent wrappers: their children are read as if unwrapped.
const TRANSPARENT = new Set(["w:smartTag", "w:customXml", "w:dir", "w:bdo"]);

export class DocxDocument {
  readonly pkg: DocxPackage;
  readonly styles: StyleSheet;
  readonly numbering: NumberingDefinitions;
  /** Top-level body blocks in order. */
  readonly blocks: Block[] = [];
  /** Every body paragraph in document order, including those in tables. */
  readonly paragraphs: ParagraphBlock[] = [];
  readonly byId = new Map<string, Block>();
  /** Bookmark name -> id of the paragraph that contains its start. */
  readonly bookmarks = new Map<string, string>();
  readonly footnotes = new Map<string, Note>();
  readonly endnotes = new Map<string, Note>();

  private readonly tracker: NumberingTracker;
  private readonly hyperlinks: Map<string, string>;
  private readonly paraIdCounts = new Map<string, number>();
  private paragraphOrdinal = 0;
  private tableOrdinal = 0;
  private opaqueOrdinal = 0;
  private readonly noteMarks = new Map<string, string>();
  private footnoteSeq = 0;
  private endnoteSeq = 0;

  private constructor(pkg: DocxPackage) {
    this.pkg = pkg;
    const stylesPart = pkg.relatedPart(MAIN_DOCUMENT_PART, REL.styles);
    const numberingPart = pkg.relatedPart(MAIN_DOCUMENT_PART, REL.numbering);
    this.styles = new StyleSheet(stylesPart ? pkg.xml(stylesPart) : undefined);
    this.numbering = new NumberingDefinitions(numberingPart ? pkg.xml(numberingPart) : undefined);
    this.tracker = new NumberingTracker(this.numbering, this.styles);
    this.hyperlinks = new Map();
    for (const rel of pkg.relationships(MAIN_DOCUMENT_PART).values()) {
      if (rel.type.endsWith(REL.hyperlink)) this.hyperlinks.set(rel.id, rel.target);
    }

    const main = pkg.xml(MAIN_DOCUMENT_PART)!;
    const body = firstChild(documentElement(main), "w:body");
    if (!body) throw new Error("Invalid .docx: w:body is missing");
    this.countParaIds(body);
    this.blocks = this.readBlocks(body, MAIN_DOCUMENT_PART, undefined);
    this.readNotes("footnote");
    this.readNotes("endnote");
  }

  static async load(bytes: Buffer): Promise<DocxDocument> {
    return new DocxDocument(await DocxPackage.load(bytes));
  }

  static fromPackage(pkg: DocxPackage): DocxDocument {
    return new DocxDocument(pkg);
  }

  source(part: string = MAIN_DOCUMENT_PART): XmlSource {
    return this.pkg.xml(part)!;
  }

  // -------------------------------------------------------------------------
  // Blocks
  // -------------------------------------------------------------------------

  private countParaIds(el: XmlElement): void {
    for (const c of el.children) {
      if (c.kind !== "element") continue;
      if (c.name === "w:p") {
        const pid = c.attrs["w14:paraId"];
        if (pid) this.paraIdCounts.set(pid, (this.paraIdCounts.get(pid) ?? 0) + 1);
      }
      this.countParaIds(c);
    }
  }

  private readBlocks(
    container: XmlElement,
    part: string,
    cell: ParagraphBlock["cell"],
  ): Block[] {
    const out: Block[] = [];
    for (const child of childElements(container)) {
      switch (child.name) {
        case "w:p": {
          const p = this.readParagraph(child, part, cell, true);
          out.push(p);
          break;
        }
        case "w:tbl":
          out.push(this.readTable(child, part));
          break;
        case "w:sdt": {
          const content = firstChild(child, "w:sdtContent");
          if (content) out.push(...this.readBlocks(content, part, cell));
          break;
        }
        case "w:customXml":
          out.push(...this.readBlocks(child, part, cell));
          break;
        case "w:tblPr":
        case "w:tblGrid":
        case "w:tcPr":
          break;
        default:
          if (INVISIBLE_BLOCK.has(child.name)) {
            if (child.name === "w:bookmarkStart" && child.attrs["w:name"]) {
              // A body-level bookmark anchors to the next paragraph; recorded
              // when that paragraph is read (see pendingBookmarks).
              this.pendingBookmarks.push(child.attrs["w:name"]);
            }
            break;
          }
          out.push(this.register({
            kind: "opaque",
            id: `x${++this.opaqueOrdinal}`,
            el: child,
            part,
            name: child.name,
          }));
      }
    }
    return out;
  }

  private pendingBookmarks: string[] = [];

  private register<T extends Block>(block: T): T {
    this.byId.set(block.id, block);
    return block;
  }

  private readTable(tbl: XmlElement, part: string): TableBlock {
    const table: TableBlock = this.register({
      kind: "table",
      id: `t${++this.tableOrdinal}`,
      el: tbl,
      part,
      rows: [],
    });
    const rowEls = collectWrapped(tbl, "w:tr");
    rowEls.forEach((tr, rowIndex) => {
      const trPr = firstChild(tr, "w:trPr");
      const revision = trPr && firstChild(trPr, "w:ins") ? "ins" : trPr && firstChild(trPr, "w:del") ? "del" : undefined;
      const row: TableRow = { el: tr, revision, cells: [] };
      collectWrapped(tr, "w:tc").forEach((tc, colIndex) => {
        const tcPr = firstChild(tc, "w:tcPr");
        const span = tcPr && firstChild(tcPr, "w:gridSpan");
        const vMergeEl = tcPr && firstChild(tcPr, "w:vMerge");
        row.cells.push({
          el: tc,
          gridSpan: span ? parseInt(span.attrs["w:val"] ?? "1", 10) || 1 : 1,
          vMerge: vMergeEl ? (vMergeEl.attrs["w:val"] === "restart" ? "restart" : "continue") : undefined,
          blocks: this.readBlocks(tc, part, { tableId: table.id, row: rowIndex, col: colIndex }),
        });
      });
      table.rows.push(row);
    });
    return table;
  }

  /**
   * Word's w14:paraId when present and unique. Otherwise an ordinal counted
   * over paragraphs whose mark is not a tracked insertion; an inserted
   * paragraph is named after the paragraph it follows ("p12+1"), so
   * inserting paragraphs never renumbers the ones after them.
   */
  private paragraphId(p: XmlElement, markRevision: "ins" | "del" | undefined): string {
    const pid = p.attrs["w14:paraId"];
    if (pid && this.paraIdCounts.get(pid) === 1) {
      this.lastBaseId = pid;
      this.insertedSince = 0;
      return pid;
    }
    if (markRevision === "ins") return `${this.lastBaseId}+${++this.insertedSince}`;
    this.lastBaseId = `p${++this.paragraphOrdinal}`;
    this.insertedSince = 0;
    return this.lastBaseId;
  }

  private lastBaseId = "p0";
  private insertedSince = 0;

  private readParagraph(
    p: XmlElement,
    part: string,
    cell: ParagraphBlock["cell"],
    numbered: boolean,
    idOverride?: string,
  ): ParagraphBlock {
    const pPr = firstChild(p, "w:pPr");
    const styleId = pPr ? firstChild(pPr, "w:pStyle")?.attrs["w:val"] : undefined;
    const directNum = pPr && firstChild(pPr, "w:numPr");
    const outlineEl = pPr && firstChild(pPr, "w:outlineLvl");
    const markRPr = pPr && firstChild(pPr, "w:rPr");
    const markRevision = markRPr
      ? firstChild(markRPr, "w:ins") ? "ins" : firstChild(markRPr, "w:del") ? "del" : undefined
      : undefined;

    const id = idOverride ?? this.paragraphId(p, markRevision);
    const bookmarks = this.pendingBookmarks;
    this.pendingBookmarks = [];
    const raw = this.readInlines(p, bookmarks, part);
    const inlines = foldFields(raw);

    const outline = outlineEl
      ? parseInt(outlineEl.attrs["w:val"] ?? "9", 10)
      : this.styles.outlineLevel(styleId);

    const block: ParagraphBlock = {
      kind: "paragraph",
      id,
      el: p,
      part,
      styleId,
      styleName: this.styles.displayName(styleId ?? this.styles.defaultParagraphStyleId),
      outlineLevel: outline !== undefined && outline >= 0 && outline < 9 ? outline : undefined,
      inlines,
      text: visibleText(inlines),
      bookmarks,
      sectionBreak: !!(pPr && firstChild(pPr, "w:sectPr")),
      markRevision,
      cell,
    };

    if (numbered) {
      // A paragraph whose mark is a pending deletion still numbers in Word's
      // default (markup) view, so it is counted like any other.
      const ref = this.tracker.effectiveNumPr(directNum ? readNumPr(directNum) : undefined, styleId);
      if (ref) {
        const label = this.tracker.next(ref);
        if (label) {
          block.label = label.label || undefined;
          block.fullLabel = label.fullLabel || undefined;
          block.listLevel = label.level;
          block.isBullet = label.isBullet || undefined;
        }
      }
      this.paragraphs.push(block);
      this.register(block);
      for (const name of bookmarks) if (!this.bookmarks.has(name)) this.bookmarks.set(name, id);
    }
    return block;
  }

  // -------------------------------------------------------------------------
  // Inlines
  // -------------------------------------------------------------------------

  private readInlines(container: XmlElement, bookmarks: string[], part: string): Raw[] {
    const out: Raw[] = [];
    for (const child of childElements(container)) {
      const name = child.name;
      if (name === "w:r") {
        this.readRun(child, out, part);
      } else if (name === "w:hyperlink") {
        const rid = child.attrs["r:id"];
        out.push({
          t: "link",
          target: rid ? this.hyperlinks.get(rid) : undefined,
          anchor: child.attrs["w:anchor"],
          content: this.readInlines(child, bookmarks, part) as Inline[],
          el: child,
        });
      } else if (name === "w:ins" || name === "w:del" || name === "w:moveTo" || name === "w:moveFrom") {
        out.push({
          t: "rev",
          kind: name.slice(2) as "ins" | "del" | "moveTo" | "moveFrom",
          author: child.attrs["w:author"],
          date: child.attrs["w:date"],
          id: child.attrs["w:id"],
          content: this.readInlines(child, bookmarks, part) as Inline[],
          el: child,
        });
      } else if (name === "w:sdt") {
        const sdtPr = firstChild(child, "w:sdtPr");
        const content = firstChild(child, "w:sdtContent");
        out.push({
          t: "sdt",
          tag: sdtPr ? firstChild(sdtPr, "w:tag")?.attrs["w:val"] : undefined,
          alias: sdtPr ? firstChild(sdtPr, "w:alias")?.attrs["w:val"] : undefined,
          content: content ? (this.readInlines(content, bookmarks, part) as Inline[]) : [],
          el: child,
        });
      } else if (name === "w:fldSimple") {
        out.push({
          t: "field",
          instr: (child.attrs["w:instr"] ?? "").trim(),
          result: foldFields(this.readInlines(child, bookmarks, part)),
          el: child,
        });
      } else if (TRANSPARENT.has(name)) {
        out.push(...this.readInlines(child, bookmarks, part));
      } else if (name === "w:bookmarkStart") {
        if (child.attrs["w:name"]) bookmarks.push(child.attrs["w:name"]);
      } else if (name === "w:commentRangeStart" || INVISIBLE_INLINE.has(name)) {
        // nothing visible
      } else if (name === "m:oMath" || name === "m:oMathPara") {
        out.push({ t: "object", kind: "math", el: child });
      } else {
        out.push({ t: "object", kind: name, el: child });
      }
    }
    return out;
  }

  private readRun(run: XmlElement, out: Raw[], part: string): void {
    const rPr = firstChild(run, "w:rPr");
    const fmt = rPr ? readFmt(rPr) : {};
    const src = this.source(part);
    for (const child of childElements(run)) {
      switch (child.name) {
        case "w:t":
        case "w:delText": {
          const text = ownText(src, child);
          if (text) out.push({ t: "text", text, fmt, run, node: child });
          break;
        }
        case "w:tab":
        case "w:ptab":
          out.push({ t: "tab", run, node: child });
          break;
        case "w:br": {
          const type = child.attrs["w:type"];
          out.push({ t: "break", kind: type === "page" ? "page" : type === "column" ? "column" : "line", run, node: child });
          break;
        }
        case "w:cr":
          out.push({ t: "break", kind: "line", run, node: child });
          break;
        case "w:noBreakHyphen":
          out.push({ t: "text", text: "‑", fmt, run, node: child });
          break;
        case "w:softHyphen":
          break;
        case "w:sym": {
          const code = (child.attrs["w:char"] ?? "").toUpperCase();
          const font = child.attrs["w:font"];
          out.push({ t: "sym", char: symbolChar(font, code), font, code, run, node: child });
          break;
        }
        case "w:footnoteReference":
        case "w:endnoteReference": {
          const kind = child.name === "w:footnoteReference" ? "footnote" : "endnote";
          const id = child.attrs["w:id"] ?? "";
          out.push({ t: "note", kind, id, mark: this.noteMark(kind, id, child), run, node: child });
          break;
        }
        case "w:footnoteRef":
        case "w:endnoteRef":
          out.push({ t: "noteMark", run, node: child });
          break;
        case "w:fldChar": {
          const type = child.attrs["w:fldCharType"];
          out.push(
            type === "begin"
              ? { t: "fldBegin", node: child }
              : type === "separate"
                ? { t: "fldSep", node: child }
                : { t: "fldEnd", node: child },
          );
          break;
        }
        case "w:instrText":
        case "w:delInstrText":
          out.push({ t: "instr", text: ownText(src, child), node: child });
          break;
        case "w:commentReference":
          out.push({ t: "comment", id: child.attrs["w:id"] ?? "", run, node: child });
          break;
        case "w:drawing":
        case "w:pict":
        case "w:object":
          out.push(this.objectToken(child.name.slice(2), child, part));
          break;
        case "mc:AlternateContent":
          out.push(this.objectToken("alternateContent", child, part));
          break;
        default:
          if (!INVISIBLE_RUN_CHILD.has(child.name)) {
            out.push({ t: "object", kind: child.name, el: child });
          }
      }
    }
  }

  /**
   * An embedded object, with the text of any text boxes it holds. For
   * mc:AlternateContent only the first mc:Choice is read: Word repeats the
   * same content in mc:Fallback.
   */
  private objectToken(kind: string, el: XmlElement, part: string): Inline {
    const scope = el.name === "mc:AlternateContent" ? (firstChild(el, "mc:Choice") ?? el) : el;
    const textbox: string[] = [];
    const walk = (node: XmlElement) => {
      for (const c of childElements(node)) {
        if (c.name === "w:txbxContent") {
          for (const p of childElements(c)) {
            if (p.name === "w:p") {
              textbox.push(visibleText(foldFields(this.readInlines(p, [], part))));
            }
          }
        } else {
          walk(c);
        }
      }
    };
    walk(scope);
    return textbox.length ? { t: "object", kind, el, textbox } : { t: "object", kind, el };
  }

  private noteMark(kind: "footnote" | "endnote", id: string, ref: XmlElement): string {
    const key = `${kind}:${id}`;
    const existing = this.noteMarks.get(key);
    if (existing) return existing;
    // w:customMarkFollows: the run after the reference carries a custom mark.
    const custom = ref.attrs["w:customMarkFollows"] === "1" || ref.attrs["w:customMarkFollows"] === "true";
    const mark = custom ? "*" : String(kind === "footnote" ? ++this.footnoteSeq : ++this.endnoteSeq);
    this.noteMarks.set(key, mark);
    return mark;
  }

  // -------------------------------------------------------------------------
  // Notes
  // -------------------------------------------------------------------------

  private readNotes(kind: "footnote" | "endnote"): void {
    const part = this.pkg.relatedPart(MAIN_DOCUMENT_PART, kind === "footnote" ? REL.footnotes : REL.endnotes);
    if (!part) return;
    const xml = this.pkg.xml(part);
    if (!xml) return;
    const target = kind === "footnote" ? this.footnotes : this.endnotes;
    for (const noteEl of childElements(documentElement(xml), `w:${kind}`)) {
      const type = noteEl.attrs["w:type"];
      if (type === "separator" || type === "continuationSeparator" || type === "continuationNotice") continue;
      const id = noteEl.attrs["w:id"] ?? "";
      const paragraphs: ParagraphBlock[] = [];
      let k = 0;
      const walk = (container: XmlElement) => {
        for (const child of childElements(container)) {
          if (child.name === "w:p") {
            paragraphs.push(this.readParagraph(child, part, undefined, false, `${kind === "footnote" ? "fn" : "en"}${id}.${++k}`));
          } else if (child.name === "w:sdt") {
            const content = firstChild(child, "w:sdtContent");
            if (content) walk(content);
          } else if (child.name === "w:tbl") {
            for (const tr of collectWrapped(child, "w:tr")) for (const tc of collectWrapped(tr, "w:tc")) walk(tc);
          }
        }
      };
      walk(noteEl);
      target.set(id, {
        kind,
        id,
        mark: this.noteMarks.get(`${kind}:${id}`) ?? "?",
        paragraphs,
      });
      for (const p of paragraphs) this.byId.set(p.id, p);
    }
  }
}

/** Direct children named `name`, looking through sdt/customXml wrappers. */
function collectWrapped(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of childElements(el)) {
    if (child.name === name) out.push(child);
    else if (child.name === "w:sdt") {
      const content = firstChild(child, "w:sdtContent");
      if (content) out.push(...collectWrapped(content, name));
    } else if (child.name === "w:customXml") {
      out.push(...collectWrapped(child, name));
    }
  }
  return out;
}

function onOff(el: XmlElement | undefined): boolean {
  if (!el) return false;
  const v = el.attrs["w:val"];
  return v === undefined || (v !== "0" && v !== "false" && v !== "none");
}

function readFmt(rPr: XmlElement): Fmt {
  const fmt: Fmt = {};
  if (onOff(firstChild(rPr, "w:b"))) fmt.b = true;
  if (onOff(firstChild(rPr, "w:i"))) fmt.i = true;
  const u = firstChild(rPr, "w:u");
  if (u && u.attrs["w:val"] !== "none") fmt.u = true;
  if (onOff(firstChild(rPr, "w:strike")) || onOff(firstChild(rPr, "w:dstrike"))) fmt.strike = true;
  if (onOff(firstChild(rPr, "w:caps"))) fmt.caps = true;
  if (onOff(firstChild(rPr, "w:vanish"))) fmt.hidden = true;
  return fmt;
}

/**
 * Fold complex-field markers (begin, instr, separate, result, end) into
 * field tokens. Fields nest; a nested field inside an instruction contributes
 * its result text to the outer instruction. Markers whose partner lives in
 * another paragraph (a TOC spanning many paragraphs) are dropped and their
 * result text stays visible as ordinary content.
 */
export function foldFields(raw: Raw[]): Inline[] {
  type Frame = { instr: string; phase: "instr" | "result"; result: Inline[]; nodes: XmlElement[] };
  const out: Inline[] = [];
  const stack: Frame[] = [];
  const emit = (inline: Inline) => {
    const top = stack[stack.length - 1];
    if (top) top.nodes.push(...inlineNodes(inline));
    if (!top) out.push(inline);
    else if (top.phase === "result") top.result.push(inline);
    else if (inline.t === "field") top.instr += visibleText(inline.result);
    // Other content inside an instruction is not displayed by Word.
  };
  for (const item of raw) {
    switch (item.t) {
      case "fldBegin":
        stack.push({ instr: "", phase: "instr", result: [], nodes: [item.node] });
        break;
      case "instr": {
        const top = stack[stack.length - 1];
        if (top && top.phase === "instr") top.instr += item.text;
        if (top) top.nodes.push(item.node);
        break;
      }
      case "fldSep": {
        const top = stack[stack.length - 1];
        if (top) {
          top.phase = "result";
          top.nodes.push(item.node);
        }
        break;
      }
      case "fldEnd": {
        const frame = stack.pop();
        if (frame) {
          frame.nodes.push(item.node);
          emit({ t: "field", instr: frame.instr.trim(), result: frame.result, nodes: frame.nodes });
        }
        break;
      }
      default:
        if (item.t === "link" || item.t === "rev" || item.t === "sdt") {
          // Wrapper contents were read unfolded; fold them independently.
          emit({ ...item, content: foldFields(item.content as Raw[]) } as Inline);
        } else {
          emit(item);
        }
    }
  }
  // Unterminated fields (end marker in a later paragraph): keep the result.
  while (stack.length) {
    const frame = stack.shift()!;
    if (frame.phase === "result") out.push(...frame.result);
  }
  return out;
}

/** Run children an inline covers, in document order. */
export function inlineNodes(inline: Inline): XmlElement[] {
  switch (inline.t) {
    case "field":
      return inline.nodes ?? (inline.el ? [inline.el] : []);
    case "link":
    case "rev":
    case "sdt":
      return inline.content.flatMap(inlineNodes);
    case "object":
      return [inline.el];
    default:
      return [inline.node];
  }
}

/** Text as it currently reads: insertions in, deletions out, objects omitted. */
export function visibleText(inlines: readonly Inline[]): string {
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
        s += "\n";
        break;
      case "sym":
        s += inline.char ?? "\uFFFC";
        break;
      case "object":
        if (inline.textbox) s += inline.textbox.join("\n");
        break;
      case "note":
        s += inline.mark;
        break;
      case "field":
        s += visibleText(inline.result);
        break;
      case "link":
      case "sdt":
        s += visibleText(inline.content);
        break;
      case "rev":
        if (inline.kind === "ins" || inline.kind === "moveTo") s += visibleText(inline.content);
        break;
      default:
        break;
    }
  }
  return s;
}

// Symbol fonts draw glyphs at code points that mean something else in
// Unicode, so their raw value is never shown as text. Only mappings
// confirmed by real documents are listed.
const SYMBOL_FONT_CHARS: Record<string, Record<string, string>> = {
  // US EPA model CRADA: "15 U.S.C. <sym>3710a" — a section sign.
  "WP TypographicSymbols": { "0027": "\u00a7" },
  // Adobe Symbol encoding 0x2A (asteriskmath), at its F0xx mirror.
  Symbol: { F02A: "\u2217" },
};

const SYMBOL_FONTS = /^(Symbol|Wingdings.*|Webdings|WP .*|Marlett|MT Extra|ZapfDingbats)$/i;

function symbolChar(font: string | undefined, code: string): string | undefined {
  const value = parseInt(code, 16);
  if (!Number.isFinite(value)) return undefined;
  const known = font ? SYMBOL_FONT_CHARS[font]?.[code.padStart(4, "0")] : undefined;
  if (known) return known;
  // F000-F0FF is the private-use mirror symbol fonts use; never real text.
  if ((font && SYMBOL_FONTS.test(font)) || (value >= 0xf000 && value <= 0xf0ff)) return undefined;
  return String.fromCodePoint(value);
}
