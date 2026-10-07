import { describe, expect, it } from "vitest";
import mammoth from "mammoth";
import { corpusFiles, readCorpusFile } from "../../../__tests__/helpers/docxCorpus";
import { DocxDocument, type Block, type Inline } from "../view";
import { MAIN_DOCUMENT_PART } from "../package";
import { documentElement, firstChild, type XmlElement } from "../xmlSource";

const PROPERTY_PARENTS = new Set(["w:rPr", "w:pPr", "w:trPr", "w:tcPr", "w:tblPr", "w:sectPr", "w:numPr"]);

/** Count elements in the body the view must surface, skipping text boxes. */
function countXml(body: XmlElement): Record<string, number> {
  const counts: Record<string, number> = { note: 0, link: 0, rev: 0, object: 0, para: 0 };
  const walk = (el: XmlElement) => {
    for (const c of el.children) {
      if (c.kind !== "element") continue;
      if (c.name === "w:txbxContent" || c.name === "mc:Fallback") continue;
      if (c.name === "w:footnoteReference" || c.name === "w:endnoteReference") counts.note++;
      else if (c.name === "w:hyperlink") counts.link++;
      else if (/^w:(ins|del|moveFrom|moveTo)$/.test(c.name) && !PROPERTY_PARENTS.has(el.name)) counts.rev++;
      else if (/^(w:drawing|w:pict|w:object|mc:AlternateContent|m:oMath|m:oMathPara)$/.test(c.name)) {
        counts.object++;
        continue; // their insides are the object
      } else if (c.name === "w:p") counts.para++;
      walk(c);
    }
  };
  walk(body);
  return counts;
}

function countView(blocks: readonly Block[]): Record<string, number> {
  const counts: Record<string, number> = { note: 0, link: 0, rev: 0, object: 0, para: 0 };
  const inl = (list: readonly Inline[]) => {
    for (const i of list) {
      if (i.t === "note") counts.note++;
      else if (i.t === "link") { counts.link++; inl(i.content); }
      else if (i.t === "rev") { counts.rev++; inl(i.content); }
      else if (i.t === "sdt") inl(i.content);
      else if (i.t === "field") inl(i.result);
      else if (i.t === "object") counts.object++;
    }
  };
  const blk = (list: readonly Block[]) => {
    for (const b of list) {
      if (b.kind === "paragraph") { counts.para++; inl(b.inlines); }
      else if (b.kind === "table") for (const r of b.rows) for (const c of r.cells) blk(c.blocks);
    }
  };
  blk(blocks);
  return counts;
}

function plainForComparison(blocks: readonly Block[]): string {
  const inl = (list: readonly Inline[]): string => {
    let s = "";
    for (const i of list) {
      if (i.t === "text") s += i.text;
      else if (i.t === "field") s += inl(i.result);
      else if (i.t === "link" || i.t === "sdt") s += inl(i.content);
      else if (i.t === "rev" && (i.kind === "ins" || i.kind === "moveTo")) s += inl(i.content);
      else if (i.t === "sym") s += i.char ?? "";
      else if (i.t === "object" && i.textbox) s += i.textbox.join("");
    }
    return s;
  };
  const blk = (list: readonly Block[]): string =>
    list.map((b) => (b.kind === "paragraph" ? inl(b.inlines) : b.kind === "table" ? b.rows.map((r) => r.cells.map((c) => blk(c.blocks)).join("")).join("") : "")).join("");
  return blk(blocks);
}

const normalize = (s: string) =>
  s.normalize("NFC")
    .replace(/[\s\u00a0\u200b\u2011\u00ad-]+/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"');

/**
 * Files where the view and mammoth legitimately disagree. Each entry says
 * why; anything not listed must match exactly.
 */
const MAMMOTH_DIFFERENCES: Record<string, string> = {
  "powertools/features/TestFiles__WC__WC066-Textbox-Before-Ins-Mod.docx":
    "text box text is placed at its anchor (before the paragraph text); mammoth appends it",
  "powertools/rp/RP051-Arabic.docx": "mammoth reorders an RTL asterisk; also Symbol-font glyphs",
  "powertools/rp/RP051-Arabic-Accepted.docx": "same as RP051-Arabic",
  "public-legal/us-epa-model-crada-2025.docx":
    "a WP TypographicSymbols section sign: the view shows §, mammoth drops it",
};

describe("DocxDocument view on the Word-authored corpus", () => {
  const files = corpusFiles();

  it.each(files)("%s: surfaces every note, link, revision, object and paragraph", async (file) => {
    const doc = await DocxDocument.load(readCorpusFile(file));
    const body = firstChild(documentElement(doc.source(MAIN_DOCUMENT_PART)), "w:body")!;
    expect(countView(doc.blocks)).toEqual(countXml(body));
  });

  it.each(files)("%s: block ids are unique and resolve", async (file) => {
    const doc = await DocxDocument.load(readCorpusFile(file));
    const ids = doc.paragraphs.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of doc.paragraphs) expect(doc.byId.get(p.id)).toBe(p);
  });

  it.each(files)("%s: field instructions never leak into text", async (file) => {
    const doc = await DocxDocument.load(readCorpusFile(file));
    for (const p of doc.paragraphs) {
      expect(p.text).not.toMatch(/\\\* MERGEFORMAT|\bREF _Ref|\bPAGEREF _Toc|\bHYPERLINK \\l/);
    }
  });

  it.each(files)("%s: text agrees with mammoth (independent extraction)", async (file) => {
    const bytes = readCorpusFile(file);
    const doc = await DocxDocument.load(bytes);
    const ours = normalize(plainForComparison(doc.blocks));
    const theirs = normalize((await mammoth.extractRawText({ buffer: bytes })).value);
    if (MAMMOTH_DIFFERENCES[file]) {
      expect(ours, "listed as a known difference; remove it from the list").not.toBe(theirs);
      expect(Math.abs(ours.length - theirs.length)).toBeLessThanOrEqual(4);
    } else {
      expect(ours).toBe(theirs);
    }
  });

  it("loads the 12,600-paragraph MSC Schedules quickly", async () => {
    const bytes = readCorpusFile("public-legal/uk-msc-consolidated-schedules-v2.2a.docx");
    const start = performance.now();
    const doc = await DocxDocument.load(bytes);
    const elapsed = performance.now() - start;
    expect(doc.paragraphs.length).toBeGreaterThan(12_000);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("maps a symbol-font section sign to §", async () => {
    const doc = await DocxDocument.load(readCorpusFile("public-legal/us-epa-model-crada-2025.docx"));
    expect(doc.paragraphs.some((p) => /15 U\.S\.C\. § 3710a/.test(p.text))).toBe(true);
  });
});
