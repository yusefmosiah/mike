import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { readCorpusFile } from "../../../__tests__/helpers/docxCorpus";
import { canonicalDocx } from "../../../__tests__/helpers/trackedChangesOracle";
import { lintDocx } from "../../docxLinter";
import { applyEdits, type EditOp } from "../edit";
import { buildEditModel } from "../editModel";
import { DocxPackage, MAIN_DOCUMENT_PART } from "../package";
import { renderInlines } from "../render";
import { resolveRevisions } from "../revisions";
import { DocxDocument, type ParagraphBlock } from "../view";
import { childElements, documentElement, firstChild, scanXml, sliceOf } from "../xmlSource";

const AUTHOR = "Mike Test";
const DATE = "2026-10-07T12:00:00Z";

const MSC = "public-legal/uk-msc-core-terms-v2.2a.docx";
const SCHEDULES = "public-legal/uk-msc-consolidated-schedules-v2.2a.docx";
const CRADA = "public-legal/us-epa-model-crada-2025.docx";
const ACADEMY = "public-legal/uk-academy-commercial-transfer-agreement-2013.docx";
const COMPLICATED = "powertools/features/TestFiles__HC031-Complicated-Document.docx";
const FOOTNOTE = "powertools/features/CA008-Footnote-Reference.docx";
const TRACKED = "powertools/features/TestFiles__RA001-Tracked-Revisions-01.docx";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * How LibreOffice may legitimately differ from Word on an edited document.
 * "empty-paragraph-before-table": accepting a deleted paragraph that sits
 * directly before a table, LibreOffice keeps it as an empty paragraph;
 * Word (and our engine) remove it.
 */
type LibreOfficeNote = "empty-paragraph-before-table";

/** Edited documents, checked again by LibreOffice at the end. */
const forLibreOffice: { name: string; original: Buffer; edited: Buffer; note?: LibreOfficeNote }[] = [];

interface Edited {
  original: Buffer;
  edited: Buffer;
  before: DocxDocument;
  after: DocxDocument;
  acceptedBefore: DocxDocument;
  acceptedAfter: DocxDocument;
}

/**
 * Apply edits and check what holds for every edit:
 * - parts other than the edited ones are byte-identical;
 * - in the main part, every top-level element outside `touched` is byte-identical;
 * - the result reloads, every part scans, and the linter finds no errors;
 * - reject-all equals reject-all of the original (run formatting included).
 */
async function edit(file: string, ops: EditOp[], touched: string[], note?: LibreOfficeNote): Promise<Edited> {
  const original = readCorpusFile(file);
  const res = await applyEdits(original, ops, { author: AUTHOR, date: DATE });
  if (!res.ok) throw new Error(`edit failed: ${JSON.stringify(res.errors)}`);
  const edited = res.bytes;

  // Package: only document.xml / notes may change.
  const a = await JSZip.loadAsync(original);
  const b = await JSZip.loadAsync(edited);
  expect(Object.keys(b.files).sort()).toEqual(Object.keys(a.files).sort());
  for (const name of Object.keys(a.files)) {
    if (a.files[name].dir) continue;
    const x = await a.file(name)!.async("nodebuffer");
    const y = await b.file(name)!.async("nodebuffer");
    if (!x.equals(y)) expect(name).toMatch(/^word\/(document|footnotes|endnotes)\.xml$/);
  }

  // Main part: untouched top-level elements appear verbatim, in order.
  const before = await DocxDocument.load(original);
  const touchedEls = new Set(touched.map((id) => topLevelElement(before, id)));
  const origBody = firstChild(documentElement(before.source()), "w:body")!;
  const newXml = (await DocxPackage.load(edited)).text(MAIN_DOCUMENT_PART)!;
  let cursor = 0;
  for (const child of childElements(origBody)) {
    const slice = sliceOf(before.source(), child);
    const at = newXml.indexOf(slice, cursor);
    if (touchedEls.has(child)) continue;
    expect(at, `untouched ${child.name} at ${child.start} must be byte-identical`).toBeGreaterThanOrEqual(0);
    cursor = at + slice.length;
  }

  // Reload, scan, lint.
  const pkg = await DocxPackage.load(edited);
  for (const part of pkg.partNames()) if (/\.(xml|rels)$/.test(part)) scanXml(pkg.text(part)!);
  const after = await DocxDocument.load(edited);
  const lint = await lintDocx(edited);
  expect(lint.issues.filter((i) => i.severity === "error")).toEqual([]);

  // Reject-all gives back the original.
  const rejectedAfter = await canonicalDocx((await resolveRevisions(edited, "reject")).bytes);
  const rejectedBefore = await canonicalDocx((await resolveRevisions(original, "reject")).bytes);
  expect(rejectedAfter).toEqual(rejectedBefore);

  forLibreOffice.push({ name: `${path.basename(file, ".docx")}-${forLibreOffice.length}`, original, edited, note });
  return {
    original,
    edited,
    before,
    after,
    acceptedBefore: await DocxDocument.load((await resolveRevisions(original, "accept")).bytes),
    acceptedAfter: await DocxDocument.load((await resolveRevisions(edited, "accept")).bytes),
  };
}

function topLevelElement(doc: DocxDocument, id: string) {
  const block = doc.byId.get(id);
  if (!block) throw new Error(`no block ${id}`);
  let el = block.el;
  const body = firstChild(documentElement(doc.source()), "w:body")!;
  while (el.parent && el.parent !== body) el = el.parent;
  return el;
}

function para(doc: DocxDocument, id: string): ParagraphBlock {
  const b = doc.byId.get(id);
  if (!b || b.kind !== "paragraph") throw new Error(`no paragraph ${id}`);
  return b;
}

const body = (doc: DocxDocument, id: string) => renderInlines(para(doc, id).inlines).replace(/\u00a0/g, " ");

/** Characters of a paragraph with their run properties, from the canonical form. */
async function formatted(bytes: Buffer, id: string): Promise<{ ch: string; fmt: string }[]> {
  const line = (await canonicalDocx(bytes, { ids: true })).find((l) => l.trimStart().startsWith(`${id} `));
  if (!line) throw new Error(`no line for ${id}`);
  const content = line.slice(line.indexOf(" ", line.indexOf("¶")) + 1);
  const out: { ch: string; fmt: string }[] = [];
  let fmt = "";
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === "⟨") {
      const j = content.indexOf("⟩", i);
      fmt = content.slice(i + 1, j);
      i = j;
    } else if (c === "{") {
      let depth = 1;
      let j = i + 1;
      for (; j < content.length && depth; j++) {
        if (content[j] === "{") depth++;
        else if (content[j] === "}") depth--;
      }
      out.push({ ch: "￼", fmt: content.slice(i, j) });
      i = j - 1;
    } else out.push({ ch: c, fmt });
  }
  return out;
}

/**
 * After accept-all, a replaced paragraph reads as the original with the
 * substitution, unchanged characters keep their run properties, and new
 * characters take the properties of the first replaced character (or, for
 * a pure insertion, of the character before).
 */
async function expectReplaced(e: Edited, id: string, find: string, replace: string) {
  const expected = body(e.acceptedBefore, id);
  expect(expected.split(find).length - 1, "find occurs once in the accepted original").toBe(1);
  expect(body(e.acceptedAfter, id)).toBe(expected.replace(find, replace));

  const acceptedOriginal = (await resolveRevisions(e.original, "accept")).bytes;
  const acceptedEdited = (await resolveRevisions(e.edited, "accept")).bytes;
  const was = await formatted(acceptedOriginal, id);
  const now = await formatted(acceptedEdited, id);
  let lead = 0;
  while (lead < was.length && lead < now.length && was[lead].ch === now[lead].ch) lead++;
  let trail = 0;
  while (trail < was.length - lead && trail < now.length - lead && was[was.length - 1 - trail].ch === now[now.length - 1 - trail].ch) trail++;
  expect(now.slice(0, lead)).toEqual(was.slice(0, lead));
  expect(now.slice(now.length - trail)).toEqual(was.slice(was.length - trail));
  const inherit = (was[lead] ?? was[lead - 1]).fmt;
  for (const c of now.slice(lead, now.length - trail)) {
    if (c.ch !== "￼") expect(c.fmt, `format of inserted "${c.ch}"`).toBe(lead < was.length - trail ? inherit : was[lead - 1].fmt);
  }
}

/** Accept-all leaves every paragraph other than `changed` exactly as it was. */
async function expectOthersUnchanged(e: Edited, changed: string[]) {
  const was = await canonicalDocx((await resolveRevisions(e.original, "accept")).bytes, { ids: true });
  const now = await canonicalDocx((await resolveRevisions(e.edited, "accept")).bytes, { ids: true });
  const skip = (l: string) => changed.some((id) => l.trimStart().startsWith(`${id} `));
  expect(now.filter((l) => !skip(l))).toEqual(was.filter((l) => !skip(l)));
}

async function rejected(file: string, ops: EditOp[]) {
  const res = await applyEdits(readCorpusFile(file), ops, { author: AUTHOR, date: DATE });
  expect(res.ok).toBe(false);
  return res.ok ? [] : res.errors;
}

// ---------------------------------------------------------------------------
// The edit model mirrors what read_document shows
// ---------------------------------------------------------------------------

describe("edit model", () => {
  it.each([MSC, SCHEDULES, CRADA, ACADEMY, COMPLICATED, FOOTNOTE, TRACKED])("%s: every paragraph's editable line equals its rendered line", async (file) => {
    const doc = await DocxDocument.load(readCorpusFile(file));
    const all = [...doc.paragraphs, ...[...doc.footnotes.values(), ...doc.endnotes.values()].flatMap((n) => n.paragraphs)];
    for (const p of all) {
      const model = buildEditModel(p);
      expect(model.text, p.id).toBe(renderInlines(p.inlines));
      let at = 0;
      for (const s of model.slots) {
        expect(s.start, p.id).toBe(at);
        at = s.end;
      }
      expect(at, p.id).toBe(model.text.length);
    }
  });
});

// ---------------------------------------------------------------------------
// Replace
// ---------------------------------------------------------------------------

describe("replace", () => {
  it("changes one word in a long clause as a whole-word redline", async () => {
    const e = await edit(MSC, [{ op: "replace", block: "0000011B", find: "under this Contract", replace: "under the Contract" }], ["0000011B"]);
    expect(body(e.after, "0000011B")).toContain("under {--this--}{++the++} Contract");
    await expectReplaced(e, "0000011B", "under this Contract", "under the Contract");
    await expectOthersUnchanged(e, ["0000011B"]);
  });

  it("keeps cross-reference fields around a change and edits twice in one paragraph", async () => {
    const id = "00000125";
    const e = await edit(
      MSC,
      [
        { op: "replace", block: id, find: "the Supplier shall immediately notify", replace: "the Supplier shall promptly notify" },
        { op: "replace", block: id, find: "as soon as practicable", replace: "within five Working Days" },
      ],
      [id],
    );
    const line = body(e.after, id);
    expect(line).toContain("Clauses {ref 5.3.1(a)} to {ref 5.3.1(f)}, the Supplier shall {--immediately--}{++promptly++} notify");
    expect(line).toContain("{--as soon as practicable--}{++within five Working Days++}");
    const accepted = body(e.acceptedAfter, id);
    expect(accepted).toBe(
      body(e.acceptedBefore, id).replace("immediately notify", "promptly notify").replace("as soon as practicable", "within five Working Days"),
    );
    await expectOthersUnchanged(e, [id]);
  });

  it("deletes a whole cross-reference field and the words around it", async () => {
    const id = "00000125";
    const e = await edit(MSC, [{ op: "replace", block: id, find: "Clauses {ref 5.3.1(a)} to {ref 5.3.1(f)}, the", replace: "Clause {ref 5.3.1(a)}, the" }], [id]);
    expect(body(e.after, id)).toContain("{--Clauses--}{++Clause++} {ref 5.3.1(a)}{-- to {ref 5.3.1(f)}--}, the");
    expect(body(e.acceptedAfter, id)).toContain("requirements of Clause {ref 5.3.1(a)}, the Supplier");
    // The field code goes with its result.
    const xml = (await DocxPackage.load(e.edited)).text(MAIN_DOCUMENT_PART)!;
    expect(xml).toMatch(/<w:delInstrText[^>]*>[^<]*REF /);
  });

  it("edits text inside a link without touching its target", async () => {
    const id = "0000000F";
    const e = await edit(
      MSC,
      [
        { op: "replace", block: id, find: "Contract Team at", replace: "Contract Unit at" },
        {
          op: "replace",
          block: id,
          find: "[modelservicescontract@cabinetoffice.gov.uk](mailto:modelservicescontract@cabinetoffice.gov.uk)",
          replace: "[the MSC mailbox](mailto:modelservicescontract@cabinetoffice.gov.uk)",
        },
      ],
      [id],
    );
    expect(body(e.acceptedAfter, id)).toBe(
      "If you have any questions about this document please contact the Model Services Contract Unit at [the MSC mailbox](mailto:modelservicescontract@cabinetoffice.gov.uk)",
    );
    // New link text keeps the link's run style.
    const link = (await formatted((await resolveRevisions(e.edited, "accept")).bytes, id)).at(-1)!;
    expect(link.fmt).toContain("w:u");
  });

  it("edits a table cell paragraph", async () => {
    const id = "00000021";
    const e = await edit(MSC, [{ op: "replace", block: id, find: "Corrections to Clauses", replace: "Amendments to Clauses" }], [id]);
    await expectReplaced(e, id, "Corrections to Clauses", "Amendments to Clauses");
  });

  it("replaces across italic and plain runs", async () => {
    const id = "000000C6";
    const e = await edit(MSC, [{ op: "replace", block: id, find: "Schedule 1 (Definitions) or the relevant", replace: "Schedule 1 or any relevant" }], [id]);
    expect(body(e.acceptedAfter, id)).toContain("set out in Schedule 1 or any relevant Schedule");
    await expectOthersUnchanged(e, [id]);
  });

  it("replaces inside an italic word with italic text", async () => {
    const id = "000000C6";
    const e = await edit(MSC, [{ op: "replace", block: id, find: "(Definitions)", replace: "(Defined Terms)" }], [id]);
    await expectReplaced(e, id, "(Definitions)", "(Defined Terms)");
  });

  it("deletes across a dozen runs with different spacing and size", async () => {
    const id = "26A75793";
    const find = "Act of 1986 (the “FTTA”), has found that Federal";
    const e = await edit(CRADA, [{ op: "replace", block: id, find, replace: "Act of 1986 has found that Federal" }], [id]);
    await expectReplaced(e, id, find, "Act of 1986 has found that Federal");
    // One deletion, not one per run.
    const changes = (await applyEdits(e.original, [{ op: "replace", block: id, find, replace: "Act of 1986 has found that Federal" }], { author: AUTHOR, date: DATE }));
    expect(changes.ok && changes.changes[0].revisionIds.length).toBe(1);
  });

  it("fills a highlighted bold placeholder; the new text takes the placeholder's formatting", async () => {
    const id = "p19";
    const e = await edit(ACADEMY, [{ op: "replace", block: id, find: "[Insert name of Local Authority]", replace: "Hampshire County Council" }], [id]);
    await expectReplaced(e, id, "[Insert name of Local Authority]", "Hampshire County Council");
  });

  it("matches straight quotes against curly ones", async () => {
    const id = "26A75793";
    const e = await edit(CRADA, [{ op: "replace", block: id, find: '(the "FTTA"), has found', replace: '(the "FTTA"), has determined' }], [id]);
    expect(body(e.acceptedAfter, id)).toContain("(the “FTTA”), has determined that");
  });

  it("keeps a footnote reference next to the change", async () => {
    const e = await edit(FOOTNOTE, [{ op: "replace", block: "p1", find: "[^1]Video provides a way.", replace: "[^1]Video offers a way." }], ["p1"]);
    expect(body(e.acceptedAfter, "p1")).toBe("[^1]Video offers a way.");
    expect(e.acceptedAfter.footnotes.size).toBe(1);
  });

  it("deletes a footnote reference as a tracked change", async () => {
    const e = await edit(FOOTNOTE, [{ op: "replace", block: "p1", find: "[^1]Video", replace: "Video" }], ["p1"]);
    expect(body(e.after, "p1")).toBe("{--[^1]--}Video provides a way.");
    expect(body(e.acceptedAfter, "p1")).toBe("Video provides a way.");
  });

  it("edits the text of a footnote", async () => {
    const doc = await DocxDocument.load(readCorpusFile(COMPLICATED));
    const note = [...doc.footnotes.values()][0];
    const p = note.paragraphs[0];
    const words = p.text.trim().split(/\s+/);
    const find = words.slice(0, 2).join(" ");
    const e = await edit(COMPLICATED, [{ op: "replace", block: p.id, find, replace: `${words[0]} edited` }], []);
    const edited = [...e.after.footnotes.values()][0].paragraphs[0];
    expect(renderInlines(edited.inlines)).toContain("{++edited++}");
  });

  it("edits next to an existing tracked deletion without touching it", async () => {
    const id = "3D1CEA95";
    const e = await edit(COMPLICATED, [{ op: "replace", block: id, find: "You can also type", replace: "You may also type" }], [id]);
    expect(body(e.after, id)).toContain("paste{-- in the embed code for the video you want to add--}. You {--can--}{++may++} also type");
  });

  it("deletes text inside another author's insertion (Word nests the deletion)", async () => {
    const doc = await DocxDocument.load(readCorpusFile(TRACKED));
    const p = doc.paragraphs.find((x) => renderInlines(x.inlines) === "{++Order of injection:++}")!;
    const e = await edit(TRACKED, [{ op: "replace", block: p.id, find: "{++Order of injection:++}", replace: "{++injection:++}" }], [p.id]);
    expect(body(e.after, p.id)).toBe("{++{--Order of --}injection:++}");
    // Accepted, the paragraph is no longer an insertion and gets an ordinal id.
    const count = (d: DocxDocument, text: string) => d.paragraphs.filter((x) => x.text === text).length;
    expect(count(e.acceptedAfter, "injection:")).toBe(count(e.acceptedBefore, "injection:") + 1);
    expect(count(e.acceptedAfter, "Order of injection:")).toBe(count(e.acceptedBefore, "Order of injection:") - 1);
  });
});

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

describe("insert", () => {
  it("inserts paragraphs after a clause, formatted like it", async () => {
    const anchor = "0000011B";
    const e = await edit(MSC, [{ op: "insert", after: anchor, paragraphs: ["first new clause", "second new clause"] }], []);
    const before = await canonicalDocx((await resolveRevisions(e.original, "accept")).bytes, { ids: true });
    const after = await canonicalDocx((await resolveRevisions(e.edited, "accept")).bytes, { ids: true });
    const at = before.findIndex((l) => l.startsWith(`${anchor} `));
    expect(after.slice(0, at + 1)).toEqual(before.slice(0, at + 1));
    expect(after.slice(at + 3)).toEqual(before.slice(at + 1));
    const style = before[at].match(/¶\[([^\]]*)\]/)![1];
    // Accepted, the new paragraphs are ordinary ones with the anchor's style.
    expect(after[at + 1]).toMatch(new RegExp(`¶\\[${style}\\] ⟨⟩first new clause$`));
    expect(after[at + 2]).toMatch(new RegExp(`¶\\[${style}\\] ⟨⟩second new clause$`));
    // Each new paragraph is a tracked insertion, mark included.
    expect(after.length).toBe(before.length + 2);
    const ids = e.after.paragraphs.filter((p) => p.markRevision === "ins").map((p) => p.id);
    expect(ids).toEqual([`${anchor}+1`, `${anchor}+2`]);
  });

  it("inserts before a block with a named style", async () => {
    const doc = await DocxDocument.load(readCorpusFile(MSC));
    const anchor = doc.paragraphs.find((p) => p.styleId === "Numbered11" && !p.cell)!;
    const styleName = doc.styles.displayName("Numbered111")!;
    const e = await edit(MSC, [{ op: "insert", before: anchor.id, paragraphs: ["a sub-clause"], style: styleName }], []);
    const inserted = e.after.paragraphs.find((p) => p.markRevision === "ins")!;
    expect(inserted.styleId).toBe("Numbered111");
    expect(inserted.text).toBe("a sub-clause");
  });

  it("keeps ids stable within a batch: an insert before a block does not move a later target", async () => {
    // Ordinal ids (no w14:paraId): p20 must still be p20 after inserting before it.
    const e = await edit(
      ACADEMY,
      [
        { op: "insert", after: "p19", paragraphs: ["(1A) a new party"] },
        { op: "replace", block: "p20", find: "THE GOVERNING BODY OF", replace: "THE TRUSTEES OF" },
      ],
      ["p20"],
    );
    expect(para(e.after, "p19+1").text).toBe("(1A) a new party");
    expect(body(e.after, "p20")).toContain("{--GOVERNING BODY--}{++TRUSTEES++}");
    expect(para(e.after, "p20").text).toContain("TRUSTEES OF");
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe("delete", () => {
  it("deletes a paragraph; accepting removes it and nothing else", async () => {
    const id = "0000011B";
    const e = await edit(MSC, [{ op: "delete", block: id }], [id]);
    expect(para(e.after, id).markRevision).toBe("del");
    const before = await canonicalDocx((await resolveRevisions(e.original, "accept")).bytes, { ids: true });
    const after = await canonicalDocx((await resolveRevisions(e.edited, "accept")).bytes, { ids: true });
    expect(after).toEqual(before.filter((l) => !l.startsWith(`${id} `)));
  });

  it("deletes a range of blocks spanning a table", async () => {
    const doc = await DocxDocument.load(readCorpusFile(SCHEDULES));
    const t = doc.blocks.findIndex((b, i) => b.kind === "table" && i > 50 && doc.blocks[i - 1].kind === "paragraph" && doc.blocks[i + 1]?.kind === "paragraph");
    const first = doc.blocks[t - 1].id;
    const last = doc.blocks[t + 1].id;
    const e = await edit(SCHEDULES, [{ op: "delete", block: first, through: last }], [first, doc.blocks[t].id, last], "empty-paragraph-before-table");
    const table = e.after.byId.get(doc.blocks[t].id);
    expect(table?.kind === "table" && table.rows.every((r) => r.revision === "del")).toBe(true);
    // Accepting removes the three blocks.
    expect(e.acceptedAfter.blocks.length).toBe(e.acceptedBefore.blocks.length - 3);
    expect(e.acceptedAfter.byId.has(first)).toBe(false);
    // Table ids are ordinals, so count tables rather than look one up.
    const tables = (d: DocxDocument) => d.blocks.filter((b) => b.kind === "table").length;
    expect(tables(e.acceptedAfter)).toBe(tables(e.acceptedBefore) - 1);
  });

  it("deletes empty paragraphs as tracked changes", async () => {
    const doc = await DocxDocument.load(readCorpusFile(CRADA));
    const i = doc.blocks.findIndex((b, k) => k > 5 && b.kind === "paragraph" && !b.text.trim() && doc.blocks[k + 1]?.kind === "paragraph" && !(doc.blocks[k + 1] as ParagraphBlock).text.trim());
    const a = doc.blocks[i].id;
    const b = doc.blocks[i + 1].id;
    const e = await edit(CRADA, [{ op: "delete", block: a, through: b }], [a, b]);
    expect(para(e.after, a).markRevision).toBe("del");
    expect(para(e.after, b).markRevision).toBe("del");
    expect(e.acceptedAfter.paragraphs.length).toBe(e.acceptedBefore.paragraphs.length - 2);
  });

  it("keeps the last paragraph mark of a container, as Word does", async () => {
    const doc = await DocxDocument.load(readCorpusFile(MSC));
    const lastTwo = doc.blocks.slice(-2);
    expect(lastTwo.every((b) => b.kind === "paragraph")).toBe(true);
    const e = await edit(MSC, [{ op: "delete", block: lastTwo[0].id, through: lastTwo[1].id }], lastTwo.map((b) => b.id));
    expect(para(e.after, lastTwo[0].id).markRevision).toBe("del");
    expect(para(e.after, lastTwo[1].id).markRevision).toBeUndefined();
    const last = e.acceptedAfter.blocks.at(-1) as ParagraphBlock;
    expect(last.text).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

describe("batches", () => {
  it("applies replace, insert and range delete together in one batch", async () => {
    const doc = await DocxDocument.load(readCorpusFile(MSC));
    const i = doc.blocks.findIndex((b) => b.id === "0000011B");
    const e = await edit(
      MSC,
      [
        { op: "replace", block: "0000011B", find: "under this Contract", replace: "under the Contract" },
        { op: "insert", after: "0000011B", paragraphs: ["new text"] },
        { op: "delete", block: doc.blocks[i + 2].id, through: doc.blocks[i + 3].id },
      ],
      ["0000011B", doc.blocks[i + 2].id, doc.blocks[i + 3].id],
    );
    expect(e.after.blocks.length).toBe(doc.blocks.length + 1);
  });

  it("changes nothing when one edit fails, and reports every failure", async () => {
    const errors = await rejected(MSC, [
      { op: "replace", block: "0000011B", find: "under this Contract", replace: "under the Contract" },
      { op: "replace", block: "NOPE", find: "x", replace: "y" },
      { op: "replace", block: "0000011B", find: "not in the paragraph", replace: "z" },
    ]);
    expect(errors.map((e) => e.index)).toEqual([1, 2]);
    expect(errors[0].error).toMatch(/Unknown block id/);
    expect(errors[1].error).toMatch(/Could not find/);
  });

  it("refuses overlapping edits, edits to a deleted block, and ambiguous finds", async () => {
    expect(
      (await rejected(MSC, [
        { op: "replace", block: "0000011B", find: "under this Contract", replace: "under the Contract" },
        { op: "replace", block: "0000011B", find: "this Contract, including", replace: "that Contract, including" },
      ]))[0].error,
    ).toMatch(/overlaps/);
    expect(
      (await rejected(MSC, [
        { op: "delete", block: "0000011B" },
        { op: "replace", block: "0000011B", find: "under this Contract", replace: "under the Contract" },
      ]))[0].error,
    ).toMatch(/deleted by edit 1/);
    expect((await rejected(MSC, [{ op: "replace", block: "00000125", find: "the Supplier", replace: "the Provider" }]))[0].error).toMatch(/occurs \d+ times/);
  });

  it("refuses to split tokens or type notation", async () => {
    expect((await rejected(MSC, [{ op: "replace", block: "00000125", find: "{ref 5.3.1(a)}", replace: "{ref 5.3.1(b)}" }]))[0].error).toMatch(/split|notation/);
    expect((await rejected(MSC, [{ op: "replace", block: "0000011B", find: "this Contract", replace: "this Contract[^2]" }]))[0].error).toMatch(/notation/);
    expect(
      (await rejected(COMPLICATED, [{ op: "replace", block: "3D1CEA95", find: "paste{-- in the embed", replace: "paste in the embed" }]))[0].error,
    ).toMatch(/tracked/);
  });
});

// ---------------------------------------------------------------------------
// LibreOffice reads every edited document the same way
// ---------------------------------------------------------------------------

// Slow (one LibreOffice process per edited document), so opt-in:
//   MIKE_LIBREOFFICE_TESTS=1 npm test --prefix backend -- src/lib/docx/__tests__/edit.corpus.test.ts
const runLibreOffice =
  process.env.MIKE_LIBREOFFICE_TESTS === "1" &&
  spawnSync("python3", ["-c", "import uno"]).status === 0 &&
  spawnSync("soffice", ["--version"]).status === 0;

describe.skipIf(!runLibreOffice)("LibreOffice", () => {
  it("rejects every edit back to the original and accepts to our result", async () => {
    expect(forLibreOffice.length).toBeGreaterThan(10);
    const dir = mkdtempSync(path.join(tmpdir(), "docx-lo-"));
    type Job = { in: string; mode: string; out: string };
    const groups: Job[][] = [];
    const originals = new Map<Buffer, string>();
    const cases = [];
    for (const f of forLibreOffice) {
      let orig = originals.get(f.original);
      if (!orig) {
        orig = path.join(dir, `original-${originals.size}.docx`);
        writeFileSync(orig, f.original);
        writeFileSync(`${orig}.ours-accepted.docx`, (await resolveRevisions(f.original, "accept")).bytes);
        originals.set(f.original, orig);
        groups.push([
          { in: orig, mode: "reject", out: `${orig}.rejected.txt` },
          { in: orig, mode: "accept", out: `${orig}.accepted.txt` },
          { in: `${orig}.ours-accepted.docx`, mode: "none", out: `${orig}.ours-accepted.txt` },
        ]);
      }
      const edited = path.join(dir, `${f.name}.edited.docx`);
      const ours = path.join(dir, `${f.name}.ours-accepted.docx`);
      writeFileSync(edited, f.edited);
      cases.push({ name: f.name, orig, edited, ours, note: f.note });
    }
    for (const c of cases) {
      const f = forLibreOffice.find((x) => x.name === c.name)!;
      writeFileSync(c.ours, (await resolveRevisions(f.edited, "accept")).bytes);
      groups.push([
        { in: c.edited, mode: "reject", out: `${c.edited}.rejected.txt` },
        { in: c.edited, mode: "accept", out: `${c.edited}.accepted.txt` },
        { in: c.ours, mode: "none", out: `${c.ours}.txt` },
      ]);
    }
    const jobsFile = path.join(dir, "jobs.json");
    writeFileSync(jobsFile, JSON.stringify(groups));
    const script = path.resolve(__dirname, "../../../__tests__/helpers/libreoffice/revisions.py");
    const results = execFileSync("python3", [script, jobsFile], { encoding: "utf8", timeout: 900_000 })
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { out: string; ok: boolean; error?: string });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    const read = (p: string) => readFileSync(p, "utf8").replace(/^\uFEFF/, "").replace(/[ \t]+$/gm, "");
    // The lines an edit changes: what lies between the common first and last lines.
    const hunk = (a: string, b: string) => {
      const x = a.split("\n");
      const y = b.split("\n");
      let pre = 0;
      while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
      let suf = 0;
      while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
      return { removed: x.slice(pre, x.length - suf), added: y.slice(pre, y.length - suf) };
    };
    for (const c of cases) {
      expect(read(`${c.edited}.rejected.txt`), `${c.name}: LibreOffice reject-all`).toBe(read(`${c.orig}.rejected.txt`));
      // Accept-all: the edit changes LibreOffice's result exactly as it changes ours.
      // (Where the original already has tracked changes the two engines may
      // resolve those differently; see the RA001 note in the mission receipt.)
      const lo = hunk(read(`${c.orig}.accepted.txt`), read(`${c.edited}.accepted.txt`));
      const ours = hunk(read(`${c.orig}.ours-accepted.txt`), read(`${c.ours}.txt`));
      if (c.note === "empty-paragraph-before-table") {
        // LibreOffice keeps one empty (label-only) paragraph that Word removes.
        const extra = lo.added.filter((l) => /^\s*[\w.()]*\s*$/.test(l));
        expect(extra.length, `${c.name}: the noted LibreOffice difference still occurs`).toBe(1);
        lo.added = lo.added.filter((l) => !extra.includes(l));
        expect(lo, `${c.name}: LibreOffice accept-all`).toEqual(ours);
        continue;
      }
      expect(lo, `${c.name}: LibreOffice accept-all`).toEqual(ours);
      if (read(`${c.orig}.accepted.txt`) === read(`${c.orig}.ours-accepted.txt`)) {
        expect(read(`${c.edited}.accepted.txt`), `${c.name}: LibreOffice accept-all text`).toBe(read(`${c.ours}.txt`));
      }
    }
  }, 900_000);
});

