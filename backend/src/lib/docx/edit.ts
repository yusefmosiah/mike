// Tracked-change editing on the document model.
//
// Every operation is resolved against the document as loaded, before
// anything changes, so one operation cannot shift another's target. If any
// operation fails, nothing is written and every error is returned. Changes
// touch only the runs they cover: a run is split where a change starts or
// ends and each piece keeps its own run properties.

import { randomUUID } from "node:crypto";
import { DocxPackage, MAIN_DOCUMENT_PART } from "./package";
import { XmlPatch } from "./patch";
import { buildEditModel, type CharUnit, type EditModel, type Slot, type Wrapper } from "./editModel";
import { DocxDocument, type Block, type ParagraphBlock, type TableBlock } from "./view";
import {
  childElements,
  encodeXmlAttr,
  encodeXmlText,
  firstChild,
  sliceOf,
  type XmlElement,
  type XmlSource,
} from "./xmlSource";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EditOp =
  | { op: "replace"; block: string; find: string; replace: string; reason?: string }
  | {
      op: "insert";
      after?: string;
      before?: string;
      paragraphs: string[];
      /** Paragraph style name or id; default: like the anchor paragraph. */
      style?: string;
      reason?: string;
    }
  | { op: "delete"; block: string; through?: string; reason?: string };

export interface AppliedChange {
  index: number;
  /** Logical id for the change card. */
  id: string;
  /** Every w:id this change created. Accepting or rejecting the change resolves all of them. */
  revisionIds: string[];
  delId?: string;
  insId?: string;
  deletedText: string;
  insertedText: string;
  contextBefore: string;
  contextAfter: string;
  block: string;
  reason?: string;
}

export interface EditError {
  index: number;
  error: string;
}

export type ApplyEditsResult =
  | { ok: true; bytes: Buffer; changes: AppliedChange[] }
  | { ok: false; errors: EditError[] };

export interface ApplyEditsOptions {
  author: string;
  /** ISO timestamp for the revisions (default now, to the second). */
  date?: string;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

class EditFailure extends Error {}

const fail = (message: string): never => {
  throw new EditFailure(message);
};

interface ParagraphPlan {
  model: EditModel;
  /** Units deleted per change (chars by node + index, whole nodes by node). */
  deletedChars: Map<XmlElement, Map<number, number>>;
  deletedNodes: Map<XmlElement, number>;
  insertions: Insertion[];
  /** Change that deletes this paragraph's mark. */
  markDeletedBy?: number;
  /** Rendered ranges already claimed, to detect overlapping operations. */
  claimed: { start: number; end: number; change: number }[];
}

type Insertion = {
  change: number;
  text: string;
  rPr: string;
  order: number;
} & (
  | { at: "unit"; unit: CharUnit | { node: XmlElement; run: XmlElement }; side: "after" | "before" }
  | { at: "element"; el: XmlElement; side: "after" | "before" }
  | { at: "end"; paragraph: XmlElement }
);

interface ChangeRecord {
  index: number;
  op: EditOp;
  block: string;
  deleted: string[];
  inserted: string[];
  contextBefore: string;
  contextAfter: string;
  revisionIds: string[];
  delId?: string;
  insId?: string;
}

export async function applyEdits(bytes: Buffer, ops: EditOp[], opts: ApplyEditsOptions): Promise<ApplyEditsResult> {
  const pkg = await DocxPackage.load(bytes);
  const doc = DocxDocument.fromPackage(pkg);
  const editor = new Editor(doc, opts);
  const errors: EditError[] = [];
  ops.forEach((op, index) => {
    try {
      editor.plan(op, index);
    } catch (err) {
      if (err instanceof EditFailure) errors.push({ index, error: err.message });
      else throw err;
    }
  });
  if (ops.length === 0) errors.push({ index: 0, error: "No edits given." });
  if (errors.length) return { ok: false, errors };
  const changes = editor.write();
  return { ok: true, bytes: await pkg.save(), changes };
}

class Editor {
  private readonly doc: DocxDocument;
  private readonly author: string;
  private readonly date: string;
  private nextId: number;
  private readonly plans = new Map<string, ParagraphPlan>();
  private readonly changes: ChangeRecord[] = [];
  private readonly elementInserts: { el: XmlElement; part: string; side: "after" | "before"; xml: string; order: number }[] = [];
  private readonly rowDeletes: { row: XmlElement; part: string; change: number }[] = [];
  /** Paragraph id -> index of the delete operation that removes it. */
  private readonly deletedBy = new Map<string, number>();
  private insertOrder = 0;

  constructor(doc: DocxDocument, opts: ApplyEditsOptions) {
    this.doc = doc;
    this.author = opts.author;
    this.date = opts.date ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    this.nextId = maxRevisionId(doc.pkg) + 1;
  }

  private newId(change: ChangeRecord, kind: "ins" | "del"): string {
    const id = String(this.nextId++);
    change.revisionIds.push(id);
    if (kind === "del") change.delId ??= id;
    else change.insId ??= id;
    return id;
  }

  private revAttrs(id: string): string {
    return ` w:id="${id}" w:author="${encodeXmlAttr(this.author)}" w:date="${this.date}"`;
  }

  // -------------------------------------------------------------------------
  // Operation planning
  // -------------------------------------------------------------------------

  plan(op: EditOp, index: number): void {
    switch (op?.op) {
      case "replace":
        return this.planReplace(op, index);
      case "insert":
        return this.planInsert(op, index);
      case "delete":
        return this.planDelete(op, index);
      default:
        fail(`Unknown op ${JSON.stringify((op as { op?: unknown })?.op)}; use "replace", "insert" or "delete".`);
    }
  }

  private block(id: string | undefined, what: string): Block {
    if (!id || typeof id !== "string") fail(`${what} is required (a block id from read_document, e.g. "0000029F").`);
    const clean = id!.trim().replace(/^\[|\]$/g, "");
    const block = this.doc.byId.get(clean);
    if (!block) {
      fail(
        `Unknown block id "${id}". Use the id in brackets at the start of a line from read_document or find_in_document for the current version of this document.`,
      );
    }
    return block!;
  }

  private planFor(p: ParagraphBlock): ParagraphPlan {
    let plan = this.plans.get(p.id);
    if (!plan) {
      plan = { model: buildEditModel(p), deletedChars: new Map(), deletedNodes: new Map(), insertions: [], claimed: [] };
      this.plans.set(p.id, plan);
    }
    return plan;
  }

  private record(op: EditOp, index: number, block: string): ChangeRecord {
    const rec: ChangeRecord = {
      index,
      op,
      block,
      deleted: [],
      inserted: [],
      contextBefore: "",
      contextAfter: "",
      revisionIds: [],
    };
    this.changes.push(rec);
    return rec;
  }


  // --- replace -------------------------------------------------------------

  private planReplace(op: Extract<EditOp, { op: "replace" }>, index: number): void {
    const block = this.block(op.block, "block");
    if (block.kind !== "paragraph") {
      fail(
        block.kind === "table"
          ? `Block ${block.id} is a table. Edit the paragraphs inside it by their own ids (shown after rNcM on each cell line).`
          : `Block ${block.id} cannot be edited.`,
      );
    }
    const p = block as ParagraphBlock;
    const deletedBy = this.deletedBy.get(p.id);
    if (deletedBy !== undefined) fail(`Block ${p.id} is deleted by edit ${deletedBy + 1} in this batch.`);
    if (typeof op.find !== "string" || op.find.length === 0) fail("find is required: copy the exact words to change from the block's line.");
    if (typeof op.replace !== "string") fail("replace is required (use an empty string to delete).");

    const plan = this.planFor(p);
    const model = plan.model;
    let find = op.find;
    let replace = op.replace;
    ({ find, replace } = stripLinePrefix(p, find, replace));
    if (find === replace) fail("find and replace are identical; nothing would change.");

    const match = locate(model.text, find);
    if (match.kind === "none") {
      fail(
        `Could not find ${JSON.stringify(truncate(op.find, 80))} in block ${p.id}. The block currently reads: ${JSON.stringify(truncate(model.text, 400))}`,
      );
    }
    if (match.kind === "many") {
      fail(`${JSON.stringify(truncate(op.find, 80))} occurs ${match.count} times in block ${p.id}; include more of the surrounding words so it occurs once.`);
    }
    const m = match as Extract<ReturnType<typeof locate>, { kind: "one" }>;

    // Only what differs becomes tracked changes: a word-level diff, so
    // tokens kept in both find and replace stay untouched between hunks.
    const hunks = diffHunks(find, replace);
    const rec = this.record(op, index, p.id);
    const changeIdx = this.changes.length - 1;
    for (const h of hunks) checkTypedText(replace.slice(h.rs, h.re));
    for (const h of hunks) {
      this.applyRegion(plan, m.map(h.fs), m.map(h.fe), replace.slice(h.rs, h.re), changeIdx, rec);
    }
    const first = m.map(hunks[0].fs);
    const last = m.map(hunks[hunks.length - 1].fe);
    rec.contextBefore = tail(stripMarkup(model.text.slice(0, first)), 40);
    rec.contextAfter = head(stripMarkup(model.text.slice(last)), 40);
  }

  /** Mark [start, end) deleted and `inserted` inserted, for change `changeIdx`. */
  private applyRegion(plan: ParagraphPlan, start: number, end: number, inserted: string, changeIdx: number, rec: ChangeRecord): void {
    const model = plan.model;
    for (const c of plan.claimed) {
      if (c.change === changeIdx) continue;
      const overlaps = start < c.end && c.start < end;
      const samePoint = start === end && c.start === c.end && start === c.start;
      if (overlaps || samePoint) fail(`This change overlaps edit ${this.changes[c.change].index + 1} in the same block.`);
    }
    plan.claimed.push({ start, end, change: changeIdx });

    // Deletions.
    const deletedText: string[] = [];
    for (const slot of model.slots) {
      if (slot.end <= start || slot.start >= end) {
        if (!(slot.start === slot.end && slot.start > start && slot.start < end)) continue;
      }
      const inside = slot.start >= start && slot.end <= end;
      switch (slot.kind) {
        case "text":
          this.markChar(plan, slot.unit, changeIdx);
          deletedText.push(model.text.slice(slot.start, slot.end));
          break;
        case "token":
          if (!inside) fail(`The change would split ${slot.label}; include all of it or none of it.`);
          if (!slot.deletable) fail(slot.why ?? `${slot.label} cannot be deleted as a tracked change.`);
          for (const n of slot.nodes) plan.deletedNodes.set(n, changeIdx);
          deletedText.push(slot.label);
          break;
        case "markup": {
          const owner = slot.owner;
          if (owner.start < start || owner.end > end) {
            fail(
              owner.kind === "link"
                ? "The change would break a link's [text](url) markup. Change the link text inside the brackets, or delete the whole link."
                : "Existing tracked changes ({++…++} and {--…--}) are accepted or rejected by the user, not by edit_document. Leave their markup in place.",
            );
          }
          break;
        }
        case "frozen":
          if (!inside) fail("The change would split an existing tracked deletion ({--…--}); include all of it or none of it.");
          break;
      }
    }
    // Fields whose whole result is deleted go with their codes.
    for (const f of model.fields) {
      const covered = f.wrapper.start >= start && f.wrapper.end <= end && (f.wrapper.end > f.wrapper.start || (f.wrapper.start > start && f.wrapper.start < end));
      if (covered) for (const n of f.nodes) plan.deletedNodes.set(n, changeIdx);
    }
    rec.deleted.push(deletedText.join(""));

    // Insertion.
    if (inserted) {
      rec.inserted.push(inserted);
      plan.insertions.push(this.insertionPoint(plan, start, end, inserted, changeIdx));
    }
  }

  private markChar(plan: ParagraphPlan, unit: CharUnit, change: number): void {
    if (unit.index === undefined) {
      plan.deletedNodes.set(unit.node, change);
      return;
    }
    let m = plan.deletedChars.get(unit.node);
    if (!m) {
      m = new Map();
      plan.deletedChars.set(unit.node, m);
    }
    m.set(unit.index, change);
  }

  /**
   * Where new text goes. With a deletion it follows the first deleted text,
   * in the same container and with that text's formatting (Word's
   * "replace selection"). A pure insertion attaches to the text beside it
   * that is not separated from it by link or revision markup.
   */
  private insertionPoint(plan: ParagraphPlan, start: number, end: number, text: string, change: number): Insertion {
    const model = plan.model;
    const slots = model.slots;
    const order = this.insertOrder++;
    const isTextLike = (s: Slot | undefined): s is Extract<Slot, { kind: "text" }> => s?.kind === "text";
    const inRevision = (s: Slot) => s.wrappers.some((w) => w.kind === "ins" || w.kind === "del");

    if (end > start) {
      // Last slot of the first contiguous deleted stretch in one container.
      const deleted = slots.filter((s) => s.start >= start && s.end <= end && (s.kind === "text" || s.kind === "token") && s.end > s.start);
      if (deleted.length === 0) fail("Nothing to replace in the selected text.");
      const first = deleted[0];
      let last = first;
      for (const s of deleted.slice(1)) {
        if (sameContainer(s, first) && s.start === last.end) last = s;
        else break;
      }
      if (inRevision(first) || inRevision(last)) {
        const rev = [...last.wrappers].reverse().find((w) => w.kind === "ins")!;
        // Replacing text inside an existing insertion: new text may only follow it.
        if (rev.end - "++}".length > end) {
          fail("New text cannot go inside an existing tracked insertion ({++…++}). Delete the whole insertion and insert the new text after it.");
        }
        return { change, text, rPr: this.rPrNear(plan, first.start, "after"), order, at: "element", el: rev.el!, side: "after" };
      }
      const rPr = this.rPrNear(plan, first.start, "after");
      return { change, text, rPr, order, ...this.anchorAfter(last) };
    }

    // Pure insertion at `start`.
    const before = [...slots].reverse().find((s) => s.end <= start && s.end > s.start);
    const after = slots.find((s) => s.start >= start && s.end > s.start);
    const adjacentBefore = before && before.end === start;
    const adjacentAfter = after && after.start === start;
    const rPr = this.rPrNear(plan, start, "before");
    if (adjacentBefore && (isTextLike(before) || before!.kind === "token") && !inRevision(before!)) {
      return { change, text, rPr, order, ...this.anchorAfter(before!) };
    }
    if (adjacentAfter && (isTextLike(after) || after!.kind === "token") && !inRevision(after!)) {
      return { change, text, rPr, order, ...this.anchorBefore(after!) };
    }
    // Between markup: step outside the wrapper the markup belongs to.
    if (adjacentBefore && (before!.kind === "markup" || before!.kind === "frozen")) {
      const owner = before!.owner;
      if (owner.end === start && owner.el) {
        if (owner.kind === "ins" && after && after.wrappers.includes(owner)) {
          fail("New text cannot go inside an existing tracked insertion ({++…++}).");
        }
        return { change, text, rPr, order, at: "element", el: outermostAt(before!, owner).el!, side: "after" };
      }
    }
    if (adjacentAfter && (after!.kind === "markup" || after!.kind === "frozen")) {
      const owner = after!.owner;
      if (owner.start === start && owner.el) {
        return { change, text, rPr, order, at: "element", el: outermostAt(after!, owner).el!, side: "before" };
      }
    }
    if (before && inRevision(before) && after && inRevision(after) && sharedRevision(before, after)) {
      fail("New text cannot go inside an existing tracked insertion ({++…++}).");
    }
    if (!before && !after) return { change, text, rPr, order, at: "end", paragraph: model.paragraph.el };
    fail("Could not find a place for the new text; include a neighbouring word in find and replace.");
    return undefined as never;
  }

  private anchorAfter(s: Slot): Pick<Extract<Insertion, { at: "unit" }>, "at" | "unit" | "side"> {
    if (s.kind === "text") return { at: "unit", unit: s.unit, side: "after" };
    if (s.kind === "token") {
      const node = s.nodes[s.nodes.length - 1];
      return { at: "unit", unit: { node, run: node.parent! }, side: "after" };
    }
    return fail("Internal: cannot anchor after markup.");
  }

  private anchorBefore(s: Slot): Pick<Extract<Insertion, { at: "unit" }>, "at" | "unit" | "side"> {
    if (s.kind === "text") return { at: "unit", unit: s.unit, side: "before" };
    if (s.kind === "token") {
      const node = s.nodes[0];
      return { at: "unit", unit: { node, run: node.parent! }, side: "before" };
    }
    return fail("Internal: cannot anchor before markup.");
  }

  /** Run properties of the nearest real text, preferring the given side of `pos`. */
  private rPrNear(plan: ParagraphPlan, pos: number, prefer: "before" | "after"): string {
    const textSlots = plan.model.slots.filter((s): s is Extract<Slot, { kind: "text" }> => s.kind === "text" && s.unit.index !== undefined);
    const before = [...textSlots].reverse().find((s) => s.end <= pos);
    const after = textSlots.find((s) => s.start >= pos);
    const pick = prefer === "after" ? (after ?? before) : (before ?? after);
    const src = this.doc.source(plan.model.paragraph.part);
    if (pick) {
      const rPr = firstChild(pick.unit.run, "w:rPr");
      return rPr ? cleanRPr(src, rPr) : "";
    }
    return markRPr(src, plan.model.paragraph.el);
  }

  // --- insert --------------------------------------------------------------

  private planInsert(op: Extract<EditOp, { op: "insert" }>, index: number): void {
    if ((op.after === undefined) === (op.before === undefined)) fail('Give exactly one of "after" or "before" (a block id).');
    const anchor = this.block(op.after ?? op.before, op.after !== undefined ? "after" : "before");
    const side = op.after !== undefined ? "after" : "before";
    const paragraphs = Array.isArray(op.paragraphs) ? op.paragraphs.filter((t) => typeof t === "string") : [];
    if (paragraphs.length === 0) fail("paragraphs is required: a list of paragraph texts to insert.");
    for (const t of paragraphs) checkTypedText(t);
    if (anchor.kind === "opaque") fail(`Cannot insert next to block ${anchor.id}.`);

    const like = this.exemplar(anchor, op.style);
    const part = anchor.part;
    const rec = this.record(op, index, anchor.id);
    let xml = "";
    for (const text of paragraphs) {
      const markId = this.newId(rec, "ins");
      const pPr = like.pPr(`<w:ins${this.revAttrs(markId)}/>`);
      const runs = text.length ? `<w:ins${this.revAttrs(this.newId(rec, "ins"))}>${runXml(like.rPr, text)}</w:ins>` : "";
      xml += `<w:p>${pPr}${runs}</w:p>`;
    }
    rec.inserted.push(paragraphs.join("\n\n"));
    rec.contextBefore = anchor.kind === "paragraph" && side === "after" ? tail(anchor.text, 40) : "";
    rec.contextAfter = anchor.kind === "paragraph" && side === "before" ? head(anchor.text, 40) : "";
    this.elementInserts.push({ el: anchor.el, part, side, xml, order: this.insertOrder++ });
  }

  /** Paragraph and run properties for new paragraphs. */
  private exemplar(anchor: Block, style: string | undefined): { pPr: (marker: string) => string; rPr: string } {
    let model: ParagraphBlock | undefined;
    let styleId: string | undefined;
    if (style !== undefined && style !== "") {
      styleId = this.doc.styles.resolveId(style);
      if (!styleId) fail(`Unknown paragraph style "${style}". Use a style name shown in the document, or leave style out to match the neighbouring paragraph.`);
      model = this.nearestParagraph(anchor, (p) => p.styleId === styleId);
    } else {
      model = anchor.kind === "paragraph" ? anchor : this.nearestParagraph(anchor, () => true);
    }
    const src = model ? this.doc.source(model.part) : undefined;
    const rPr = model && src ? dominantRPr(src, model) : "";
    return {
      rPr,
      pPr: (marker) => {
        const props: string[] = [];
        const modelPPr = model ? firstChild(model.el, "w:pPr") : undefined;
        if (modelPPr && src) {
          for (const c of childElements(modelPPr)) {
            if (/^w:(rPr|sectPr|pPrChange)$/.test(c.name)) continue;
            props.push(sliceOf(src, c));
          }
        } else if (styleId) {
          props.push(`<w:pStyle w:val="${encodeXmlAttr(styleId)}"/>`);
        }
        const mark = model && src ? markRPrInner(src, model.el) : "";
        return `<w:pPr>${props.join("")}<w:rPr>${marker}${mark}</w:rPr></w:pPr>`;
      },
    };
  }

  private nearestParagraph(anchor: Block, accept: (p: ParagraphBlock) => boolean): ParagraphBlock | undefined {
    const inCell = anchor.kind === "paragraph" && anchor.cell !== undefined;
    const all = this.doc.paragraphs.filter((p) => p === anchor || (p.cell !== undefined) === inCell);
    const at = anchor.kind === "paragraph" ? all.indexOf(anchor) : all.findIndex((p) => p.el.start > anchor.el.start);
    const pivot = at === -1 ? all.length - 1 : at;
    for (let d = 0; d < all.length; d++) {
      for (const i of [pivot - d, pivot + d]) {
        const p = all[i];
        if (p && p.part === anchor.part && accept(p)) return p;
      }
    }
    return undefined;
  }

  // --- delete --------------------------------------------------------------

  private planDelete(op: Extract<EditOp, { op: "delete" }>, index: number): void {
    const first = this.block(op.block, "block");
    const last = op.through !== undefined ? this.block(op.through, "through") : first;
    const list = this.siblings(first);
    const i = list.indexOf(first);
    const j = list.indexOf(last);
    if (j === -1) fail(`Blocks ${first.id} and ${last.id} are not in the same container (body, table cell or note).`);
    if (j < i) fail(`through (${last.id}) comes before block (${first.id}).`);
    const blocks = list.slice(i, j + 1);
    const rec = this.record(op, index, first.id);
    const changeIdx = this.changes.length - 1;

    const deletedTexts: string[] = [];
    const endsContainer = j === list.length - 1;
    blocks.forEach((b, k) => {
      const keepMark = k === blocks.length - 1 && endsContainer;
      if (b.kind === "paragraph") {
        deletedTexts.push(this.deleteParagraph(b, changeIdx, keepMark, index));
      } else if (b.kind === "table") {
        deletedTexts.push(this.deleteTable(b, changeIdx, index));
      } else {
        fail(`Block ${b.id} (${b.name}) cannot be deleted as a tracked change.`);
      }
    });
    rec.deleted.push(deletedTexts.join("\n"));
    const before = list[i - 1];
    const after = list[j + 1];
    rec.contextBefore = before?.kind === "paragraph" ? tail(before.text, 40) : "";
    rec.contextAfter = after?.kind === "paragraph" ? head(after.text, 40) : "";
  }

  /** The blocks of the container `b` sits in: the body, a table cell, or a note. */
  private siblings(b: Block): readonly Block[] {
    if (b.kind === "paragraph" && b.cell) {
      const table = this.doc.byId.get(b.cell.tableId) as TableBlock;
      return table.rows[b.cell.row].cells[b.cell.col].blocks;
    }
    if (b.kind === "paragraph" && b.part !== MAIN_DOCUMENT_PART) {
      for (const notes of [this.doc.footnotes, this.doc.endnotes]) {
        for (const n of notes.values()) if (n.paragraphs.includes(b)) return n.paragraphs;
      }
    }
    return this.doc.blocks;
  }

  /** Delete a paragraph's content and (unless keepMark) its mark; returns its text for the card. */
  private deleteParagraph(p: ParagraphBlock, changeIdx: number, keepMark: boolean, index: number): string {
    const prior = this.deletedBy.get(p.id);
    if (prior !== undefined && prior !== index) fail(`Block ${p.id} is already deleted by edit ${prior + 1} in this batch.`);
    this.deletedBy.set(p.id, index);
    const plan = this.planFor(p);
    const other = plan.claimed.find((c) => c.change !== changeIdx);
    if (other) fail(`Block ${p.id} is changed by edit ${this.changes[other.change].index + 1} in this batch; it cannot also be deleted.`);
    const model = plan.model;
    // Everything visible except existing deletions; markup goes with its wrapper.
    for (const slot of model.slots) {
      if (slot.kind === "text") this.markChar(plan, slot.unit, changeIdx);
      else if (slot.kind === "token") {
        if (!slot.deletable) fail(`Block ${p.id}: ${slot.why ?? `${slot.label} cannot be deleted as a tracked change`}.`);
        for (const n of slot.nodes) plan.deletedNodes.set(n, changeIdx);
      }
    }
    for (const f of model.fields) for (const n of f.nodes) plan.deletedNodes.set(n, changeIdx);
    plan.claimed.push({ start: 0, end: model.text.length, change: changeIdx });
    const pPr = firstChild(p.el, "w:pPr");
    const sectionBreak = !!(pPr && firstChild(pPr, "w:sectPr"));
    if (!keepMark && !sectionBreak && p.markRevision !== "del") plan.markDeletedBy = changeIdx;
    return p.text.trim() ? p.text : "¶";
  }

  /** Delete every row (Word marks the row and its cell content). */
  private deleteTable(t: TableBlock, changeIdx: number, index: number): string {
    const texts: string[] = [];
    for (const row of t.rows) {
      if (row.revision === "del") continue;
      this.rowDeletes.push({ row: row.el, part: t.part, change: changeIdx });
      const cells: string[] = [];
      for (const cell of row.cells) {
        const parts: string[] = [];
        for (const b of cell.blocks) {
          if (b.kind === "paragraph") parts.push(this.deleteParagraph(b, changeIdx, false, index));
          else if (b.kind === "table") parts.push(this.deleteTable(b, changeIdx, index));
        }
        cells.push(parts.join(" "));
      }
      texts.push(cells.join(" | "));
    }
    return texts.join("\n");
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  write(): AppliedChange[] {
    const patches = new Map<string, XmlPatch>();
    const patchFor = (part: string) => {
      let p = patches.get(part);
      if (!p) {
        p = new XmlPatch(this.doc.source(part));
        patches.set(part, p);
      }
      return p;
    };

    // Revision ids are allocated in document order.
    for (const [, plan] of [...this.plans].sort(([, a], [, b]) => a.model.paragraph.el.start - b.model.paragraph.el.start)) {
      this.writeParagraph(plan, patchFor(plan.model.paragraph.part));
    }
    for (const r of this.rowDeletes) {
      const rec = this.changes[r.change];
      const marker = `<w:del${this.revAttrs(this.newId(rec, "del"))}/>`;
      const patch = patchFor(r.part);
      const trPr = firstChild(r.row, "w:trPr");
      if (trPr) {
        const change = firstChild(trPr, "w:trPrChange");
        if (change) patch.insertBefore(change, marker);
        else if (trPr.contentStart === trPr.end) patch.replace(trPr, `<w:trPr>${marker}</w:trPr>`);
        else patch.append(trPr, marker);
      } else {
        const tblPrEx = firstChild(r.row, "w:tblPrEx");
        if (tblPrEx) patch.insertAfter(tblPrEx, `<w:trPr>${marker}</w:trPr>`);
        else patch.prepend(r.row, `<w:trPr>${marker}</w:trPr>`);
      }
    }
    for (const ins of this.elementInserts.sort((a, b) => a.order - b.order)) {
      const patch = patchFor(ins.part);
      if (ins.side === "after") patch.insertAfter(ins.el, ins.xml);
      else patch.insertBefore(ins.el, ins.xml);
    }
    for (const [part, patch] of patches) {
      if (!patch.isEmpty) this.doc.pkg.setText(part, patch.toString());
    }

    return this.changes.map((c) => ({
      index: c.index,
      id: `mike-${randomUUID().slice(0, 8)}-${c.index}`,
      revisionIds: c.revisionIds,
      delId: c.delId,
      insId: c.insId,
      deletedText: c.deleted.filter(Boolean).join(" … "),
      insertedText: c.inserted.filter(Boolean).join(" … "),
      contextBefore: c.contextBefore,
      contextAfter: c.contextAfter,
      block: c.block,
      reason: c.op.reason,
    }));
  }

  private writeParagraph(plan: ParagraphPlan, patch: XmlPatch): void {
    const p = plan.model.paragraph;
    const src = this.doc.source(p.part);

    // Group affected runs by their parent so deletions of adjacent runs
    // share one w:del.
    const unitInsertions = new Map<XmlElement, Insertion[]>();
    for (const ins of plan.insertions) {
      if (ins.at === "unit") {
        const list = unitInsertions.get(ins.unit.run) ?? [];
        list.push(ins);
        unitInsertions.set(ins.unit.run, list);
      }
    }
    const affectedRuns = new Set<XmlElement>(unitInsertions.keys());
    for (const node of plan.deletedChars.keys()) affectedRuns.add(node.parent!);
    for (const node of plan.deletedNodes.keys()) {
      if (node.parent?.name === "w:r") affectedRuns.add(node.parent);
    }

    const pieces = new Map<XmlElement, Piece[]>();
    for (const run of affectedRuns) {
      pieces.set(run, this.splitRun(run, src, plan, unitInsertions.get(run) ?? []));
    }

    const byParent = new Map<XmlElement, XmlElement[]>();
    for (const run of affectedRuns) {
      const list = byParent.get(run.parent!) ?? [];
      list.push(run);
      byParent.set(run.parent!, list);
    }
    for (const [parent, runs] of byParent) {
      const set = new Set(runs);
      const siblings = childElements(parent);
      // Walk siblings so a w:del can open in one run's replacement and close
      // in a later one. Bookmarks, proofing marks and runs with nothing
      // visible may sit inside the group; anything else closes it.
      const continues = (k: number) => {
        for (let m = k + 1; m < siblings.length; m++) {
          if (set.has(siblings[m])) return pieces.get(siblings[m])![0]?.kind === "del";
          if (!isTransparent(siblings[m])) return false;
        }
        return false;
      };
      let open: number | undefined;
      const openTag = (change: number) => `<w:del${this.revAttrs(this.newId(this.changes[change], "del"))}>`;
      for (let k = 0; k < siblings.length; k++) {
        const el = siblings[k];
        if (!set.has(el)) {
          if (open !== undefined && !isTransparent(el)) {
            patch.insertBefore(el, "</w:del>");
            open = undefined;
          }
          continue;
        }
        let xml = "";
        for (const piece of pieces.get(el)!) {
          if (piece.kind === "del") {
            if (open !== piece.change) {
              if (open !== undefined) xml += "</w:del>";
              xml += openTag(piece.change);
              open = piece.change;
            }
            xml += piece.xml;
          } else {
            if (open !== undefined) {
              xml += "</w:del>";
              open = undefined;
            }
            xml += piece.kind === "ins" ? `<w:ins${this.revAttrs(this.newId(this.changes[piece.change], "ins"))}>${piece.xml}</w:ins>` : piece.xml;
          }
        }
        if (open !== undefined && !continues(k)) {
          xml += "</w:del>";
          open = undefined;
        }
        patch.replace(el, xml);
      }
    }

    // Insertions anchored to wrapper elements or the paragraph end.
    for (const ins of plan.insertions.sort((a, b) => a.order - b.order)) {
      if (ins.at === "unit") continue;
      const xml = `<w:ins${this.revAttrs(this.newId(this.changes[ins.change], "ins"))}>${runXml(ins.rPr, ins.text)}</w:ins>`;
      if (ins.at === "element") {
        if (ins.side === "after") patch.insertAfter(ins.el, xml);
        else patch.insertBefore(ins.el, xml);
      } else {
        patch.append(ins.paragraph, xml);
      }
    }

    if (plan.markDeletedBy !== undefined) {
      const marker = `<w:del${this.revAttrs(this.newId(this.changes[plan.markDeletedBy], "del"))}/>`;
      addMarkMarker(patch, p.el, marker);
    }
  }

  /** Split one run into kept, deleted and inserted pieces. */
  private splitRun(run: XmlElement, src: XmlSource, plan: ParagraphPlan, insertions: Insertion[]): Piece[] {
    const rPrEl = firstChild(run, "w:rPr");
    const rPr = rPrEl ? sliceOf(src, rPrEl) : "";
    const startTag = run.contentStart === run.end ? "<w:r>" : src.source.slice(run.start, run.contentStart);
    type Unit = { state: number; xml: string; delXml: string; zeroWidth: boolean; node?: XmlElement; index?: number };
    const units: Unit[] = [];
    for (const c of run.children) {
      if (c.kind !== "element" || c === rPrEl) continue;
      if (c.name === "w:t") {
        const chars = plan.deletedChars.get(c);
        const whole = plan.deletedNodes.get(c);
        const text = decodeText(src, c);
        for (let i = 0; i < text.length; i++) {
          const state = chars?.get(i) ?? whole ?? -1;
          units.push({ state, xml: text[i], delXml: text[i], zeroWidth: false, node: c, index: i });
        }
        if (text.length === 0) units.push({ state: -1, xml: "", delXml: "", zeroWidth: true, node: c });
        continue;
      }
      const deleted = plan.deletedNodes.get(c);
      const xml = sliceOf(src, c);
      const delXml = c.name === "w:instrText" ? xml.replace(/^<w:instrText\b/, "<w:delInstrText").replace(/<\/w:instrText>$/, "</w:delInstrText>") : xml;
      const known = deleted !== undefined || isVisibleRunChild(c.name);
      units.push({ state: deleted ?? -1, xml, delXml, zeroWidth: !known, node: c });
    }
    // Invisible run children take the state of the deletion around them.
    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      if (!u.zeroWidth || u.state !== -1) continue;
      if (u.node && /^w:(fldChar|instrText)$/.test(u.node.name)) continue;
      const prev = units.slice(0, k).reverse().find((x) => !x.zeroWidth);
      const next = units.slice(k + 1).find((x) => !x.zeroWidth);
      if (prev && next && prev.state !== -1 && prev.state === next.state) u.state = prev.state;
    }

    const pieces: Piece[] = [];
    let cur: { state: number; parts: string[]; text: string } | undefined;
    const flush = () => {
      if (!cur) return;
      const body = cur.parts.join("") + textElement(cur.text, cur.state !== -1);
      if (body) {
        pieces.push(cur.state === -1 ? { kind: "keep", xml: `${startTag}${rPr}${body}</w:r>` } : { kind: "del", change: cur.state, xml: `${startTag}${rPr}${body}</w:r>` });
      }
      cur = undefined;
    };
    const add = (u: Unit) => {
      if (!cur || cur.state !== u.state) {
        flush();
        cur = { state: u.state, parts: [], text: "" };
      }
      if (u.index !== undefined) cur.text += u.xml;
      else {
        if (cur.text) {
          cur.parts.push(textElement(cur.text, cur.state !== -1));
          cur.text = "";
        }
        cur.parts.push(cur.state === -1 ? u.xml : u.delXml);
      }
    };
    const insertHere = (list: Insertion[]) => {
      if (!list.length) return;
      flush();
      for (const ins of list.sort((a, b) => a.order - b.order)) {
        pieces.push({ kind: "ins", change: ins.change, xml: runXml(ins.rPr, ins.text) });
      }
    };
    const matches = (ins: Insertion, u: Unit, side: "after" | "before") =>
      ins.at === "unit" && ins.side === side && ins.unit.node === u.node && (ins.unit as CharUnit).index === u.index;

    for (const u of units) {
      insertHere(insertions.filter((ins) => matches(ins, u, "before")));
      add(u);
      insertHere(insertions.filter((ins) => matches(ins, u, "after")));
    }
    flush();
    return pieces;
  }
}

type Piece = { kind: "keep"; xml: string } | { kind: "del"; change: number; xml: string } | { kind: "ins"; change: number; xml: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VISIBLE_RUN_CHILDREN = new Set([
  "w:t",
  "w:tab",
  "w:ptab",
  "w:br",
  "w:cr",
  "w:sym",
  "w:noBreakHyphen",
  "w:footnoteReference",
  "w:endnoteReference",
  "w:commentReference",
  "w:drawing",
  "w:pict",
  "w:object",
  "mc:AlternateContent",
]);

const TRANSPARENT_SIBLINGS = new Set(["w:bookmarkStart", "w:bookmarkEnd", "w:proofErr", "w:commentRangeStart", "w:commentRangeEnd", "w:permStart", "w:permEnd"]);

/** Siblings a w:del may enclose without changing what it deletes. */
function isTransparent(el: XmlElement): boolean {
  if (TRANSPARENT_SIBLINGS.has(el.name)) return true;
  if (el.name !== "w:r") return false;
  return el.children.every((c) => c.kind !== "element" || c.name === "w:rPr" || c.name === "w:lastRenderedPageBreak");
}

function isVisibleRunChild(name: string): boolean {
  return VISIBLE_RUN_CHILDREN.has(name);
}

function decodeText(src: XmlSource, t: XmlElement): string {
  let s = "";
  for (const c of t.children) {
    if (c.kind !== "text") continue;
    const raw = src.source.slice(c.start, c.end);
    s += raw.startsWith("<![CDATA[") ? raw.slice(9, -3) : raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
      switch (e) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        default:
          return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      }
    });
  }
  return s;
}

function textElement(text: string, deleted: boolean): string {
  if (!text) return "";
  const tag = deleted ? "w:delText" : "w:t";
  return `<${tag} xml:space="preserve">${encodeXmlText(text)}</${tag}>`;
}

/** Runs for new text: tabs and line breaks become w:tab and w:br. */
export function runXml(rPr: string, text: string): string {
  let body = "";
  let buf = "";
  const flush = () => {
    if (buf) body += `<w:t xml:space="preserve">${encodeXmlText(buf)}</w:t>`;
    buf = "";
  };
  for (const ch of text) {
    if (ch === "\t") {
      flush();
      body += "<w:tab/>";
    } else if (ch === "\n") {
      flush();
      body += "<w:br/>";
    } else buf += ch;
  }
  flush();
  return `<w:r>${rPr}${body}</w:r>`;
}

const REVISION_IN_RPR = /^w:(ins|del|moveFrom|moveTo|rPrChange)$/;

/** A run's rPr without revision records. */
function cleanRPr(src: XmlSource, rPr: XmlElement): string {
  const kids = childElements(rPr).filter((c) => !REVISION_IN_RPR.test(c.name));
  if (kids.length === 0) return "";
  return `<w:rPr>${kids.map((c) => sliceOf(src, c)).join("")}</w:rPr>`;
}

/** Paragraph-mark run properties (pPr/rPr) without revision records, as children. */
function markRPrInner(src: XmlSource, p: XmlElement): string {
  const pPr = firstChild(p, "w:pPr");
  const rPr = pPr && firstChild(pPr, "w:rPr");
  if (!rPr) return "";
  return childElements(rPr)
    .filter((c) => !REVISION_IN_RPR.test(c.name))
    .map((c) => sliceOf(src, c))
    .join("");
}

function markRPr(src: XmlSource, p: XmlElement): string {
  const inner = markRPrInner(src, p);
  return inner ? `<w:rPr>${inner}</w:rPr>` : "";
}

/** The run properties covering the most text in a paragraph. */
function dominantRPr(src: XmlSource, p: ParagraphBlock): string {
  const weight = new Map<string, number>();
  const visit = (el: XmlElement) => {
    for (const c of el.children) {
      if (c.kind !== "element" || c.name === "w:pPr" || c.name === "w:del" || c.name === "w:moveFrom") continue;
      if (c.name === "w:r") {
        let n = 0;
        for (const k of c.children) if (k.kind === "element" && k.name === "w:t") n += decodeText(src, k).length;
        if (n === 0) continue;
        const rPr = firstChild(c, "w:rPr");
        const key = rPr ? cleanRPr(src, rPr) : "";
        weight.set(key, (weight.get(key) ?? 0) + n);
      } else visit(c);
    }
  };
  visit(p.el);
  let best = "";
  let max = -1;
  for (const [k, n] of weight) if (n > max) [best, max] = [k, n];
  return max === -1 ? markRPr(src, p.el) : best;
}

/** Add a revision marker to a paragraph's mark (pPr/rPr), creating either as needed. */
function addMarkMarker(patch: XmlPatch, p: XmlElement, marker: string): void {
  const pPr = firstChild(p, "w:pPr");
  if (!pPr) {
    patch.prepend(p, `<w:pPr><w:rPr>${marker}</w:rPr></w:pPr>`);
    return;
  }
  const rPr = firstChild(pPr, "w:rPr");
  if (rPr) {
    // Markers lead CT_ParaRPr, in the order ins, del, moveFrom, moveTo.
    const ins = firstChild(rPr, "w:ins");
    if (ins) patch.insertAfter(ins, marker);
    else if (rPr.contentStart === rPr.end) patch.replace(rPr, `<w:rPr>${marker}</w:rPr>`);
    else patch.prepend(rPr, marker);
    return;
  }
  const after = firstChild(pPr, "w:sectPr") ?? firstChild(pPr, "w:pPrChange");
  if (after) patch.insertBefore(after, `<w:rPr>${marker}</w:rPr>`);
  else if (pPr.contentStart === pPr.end) patch.replace(pPr, `<w:pPr><w:rPr>${marker}</w:rPr></w:pPr>`);
  else patch.append(pPr, `<w:rPr>${marker}</w:rPr>`);
}

/** Elements whose w:id shares Word's annotation id space. */
const ANNOTATION_ID =
  /<w:(?:ins|del|moveFrom|moveTo|moveFromRangeStart|moveToRangeStart|rPrChange|pPrChange|sectPrChange|tblPrChange|trPrChange|tcPrChange|tblGridChange|tblPrExChange|cellIns|cellDel|cellMerge|numberingChange|customXml\w*RangeStart|bookmarkStart|commentRangeStart|comment|permStart)\b[^>]*?\bw:id="(\d+)"/g;

/** Highest annotation id in the parts that can hold revisions. */
function maxRevisionId(pkg: DocxPackage): number {
  let max = 0;
  for (const part of pkg.partNames()) {
    if (!/^word\/[^/]+\.xml$/i.test(part)) continue;
    const text = pkg.text(part) ?? "";
    for (const m of text.matchAll(ANNOTATION_ID)) {
      const v = parseInt(m[1], 10);
      if (v > max) max = v;
    }
  }
  return max;
}

function sameContainer(a: Slot, b: Slot): boolean {
  const ca = a.kind === "text" ? a.unit.run.parent : a.kind === "token" ? a.nodes[0]?.parent?.parent : undefined;
  const cb = b.kind === "text" ? b.unit.run.parent : b.kind === "token" ? b.nodes[0]?.parent?.parent : undefined;
  return ca !== undefined && ca === cb;
}

function sharedRevision(a: Slot, b: Slot): boolean {
  return a.wrappers.some((w) => (w.kind === "ins" || w.kind === "del") && b.wrappers.includes(w));
}

/** The outermost wrapper of `slot` that starts/ends where `owner` does. */
function outermostAt(slot: Slot, owner: Wrapper): Wrapper {
  const i = slot.wrappers.indexOf(owner);
  let out = owner;
  for (let k = i - 1; k >= 0; k--) {
    const w = slot.wrappers[k];
    if (w.el && ((w.end === owner.end && owner.end === slot.end) || (w.start === owner.start && owner.start === slot.start))) out = w;
    else break;
  }
  return out;
}

const TOKEN_SYNTAX = /\[\^e?\d+\]|\{(?:ref |image\}|equation\}|comment \d|page break\}|section break\}|textbox|symbol |embedded object\})|\{\+\+|\+\+\}|\{--|--\}|\]\((?:https?|mailto):/;

function checkTypedText(text: string): void {
  const m = text.match(TOKEN_SYNTAX);
  if (m) {
    fail(
      `New text contains ${JSON.stringify(m[0])}, which is read_document notation, not document text. Footnote references, cross-references, links, images and tracked changes cannot be typed; keep existing ones by leaving them unchanged in find and replace.`,
    );
  }
}

/** Accept a find/replace pair copied with the line's "[id] # label" prefix. */
function stripLinePrefix(p: ParagraphBlock, find: string, replace: string): { find: string; replace: string } {
  const prefixes = [`[${p.id}] `, "# ", "## ", "### ", "#### ", "##### ", "###### "];
  const label = p.fullLabel ?? p.label;
  if (label) prefixes.push(`${label} `);
  let changed = true;
  while (changed) {
    changed = false;
    for (const pre of prefixes) {
      if (find.startsWith(pre) && replace.startsWith(pre)) {
        find = find.slice(pre.length);
        replace = replace.slice(pre.length);
        changed = true;
      }
    }
  }
  return { find, replace };
}

// --- matching ---------------------------------------------------------------

function preNormalize(s: string): string {
  return s
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[‑–—]/g, "-")
    .replace(/[ ​]/g, " ");
}

interface Normalized {
  norm: string;
  /** norm index -> original index */
  orig: number[];
}

function normalize(input: string): Normalized {
  const s = preNormalize(input);
  let norm = "";
  const orig: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      if (!prevSpace) {
        norm += " ";
        orig.push(i);
      }
      prevSpace = true;
    } else {
      norm += ch;
      orig.push(i);
      prevSpace = false;
    }
  }
  return { norm, orig };
}

type Located = { kind: "none" } | { kind: "many"; count: number } | { kind: "one"; map: (findOffset: number) => number };

/**
 * Find `find` in the rendered line, tolerant of quote style, dashes and
 * whitespace. `map` turns an offset in `find` into an offset in the line.
 */
function locate(line: string, find: string): Located {
  const hay = normalize(line);
  const needle = normalize(find);
  const n = needle.norm.trim();
  if (!n) return { kind: "none" };
  const lead = needle.norm.length - needle.norm.trimStart().length;
  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const at = hay.norm.indexOf(n, from);
    if (at === -1) break;
    hits.push(at);
    from = at + 1;
  }
  if (hits.length === 0) return { kind: "none" };
  if (hits.length > 1) return { kind: "many", count: hits.length };
  const at = hits[0] - lead;
  return {
    kind: "one",
    map: (offset: number) => {
      // Normalized index of the find offset, then back to the line.
      let k = 0;
      while (k < needle.orig.length && needle.orig[k] < offset) k++;
      const normPos = at + k;
      if (normPos <= 0) return hay.orig[Math.max(0, normPos)] ?? 0;
      if (normPos >= hay.orig.length) return line.length;
      // Offsets fall between characters: one past the previous character.
      return k < needle.orig.length ? hay.orig[normPos] : hay.orig[normPos - 1] + 1;
    },
  };
}

/** Notation tokens as read_document writes them; each diffs as one unit. */
const NOTATION = /\[\^e?\d+\]|\{ref [^}]*\}|\{(?:image|equation|embedded object|page break|section break)\}|\{comment \d+\}|\{symbol [^}]*\}|\{textbox[^}]*\}|\{\+\+|\+\+\}|\{--[\s\S]*?--\}|\]\([^)\s]*\)/y;

/** Split text into diff units: notation tokens, words, whitespace runs, single other characters. */
function diffUnits(s: string): { text: string; start: number; kind: "token" | "word" | "space" | "punct" }[] {
  const out: { text: string; start: number; kind: "token" | "word" | "space" | "punct" }[] = [];
  let i = 0;
  while (i < s.length) {
    NOTATION.lastIndex = i;
    const t = NOTATION.exec(s);
    if (t) {
      out.push({ text: t[0], start: i, kind: "token" });
      i += t[0].length;
      continue;
    }
    const rest = s.slice(i);
    const w = rest.match(/^[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/u);
    if (w) {
      out.push({ text: w[0], start: i, kind: "word" });
      i += w[0].length;
      continue;
    }
    const sp = rest.match(/^\s+/);
    if (sp) {
      out.push({ text: sp[0], start: i, kind: "space" });
      i += sp[0].length;
      continue;
    }
    out.push({ text: s[i], start: i, kind: "punct" });
    i += 1;
  }
  return out;
}

interface Hunk {
  /** [fs, fe) in find is replaced by [rs, re) of replace. */
  fs: number;
  fe: number;
  rs: number;
  re: number;
}

/**
 * Word-level differences between find and replace. Hunks separated only by
 * spaces, punctuation or one short word are merged, so a rewritten phrase
 * reads as one change rather than alternating fragments; hunks are never
 * merged across a notation token, which must stay untouched.
 */
function diffHunks(find: string, replace: string): Hunk[] {
  const a = diffUnits(find);
  const b = diffUnits(replace);
  const same = (x: { text: string }, y: { text: string }) => normalize(x.text).norm === normalize(y.text).norm;
  // Trim the common prefix and suffix, then LCS on the middle.
  let pre = 0;
  while (pre < a.length && pre < b.length && same(a[pre], b[pre])) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && same(a[a.length - 1 - suf], b[b.length - 1 - suf])) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const pairs: [number, number][] = [];
  if (am.length * bm.length <= 4_000_000) {
    const n = am.length;
    const k = bm.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(k + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = k - 1; j >= 0; j--) {
        dp[i][j] = same(am[i], bm[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < k) {
      if (same(am[i], bm[j])) {
        pairs.push([pre + i, pre + j]);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
  }
  // Equal anchors: prefix, LCS pairs, suffix.
  const anchors: [number, number][] = [];
  for (let x = 0; x < pre; x++) anchors.push([x, x]);
  anchors.push(...pairs);
  for (let x = suf; x > 0; x--) anchors.push([a.length - x, b.length - x]);

  const raw: { ai: number; aj: number; bi: number; bj: number }[] = [];
  let pa = 0;
  let pb = 0;
  for (const [x, y] of [...anchors, [a.length, b.length] as [number, number]]) {
    if (x > pa || y > pb) raw.push({ ai: pa, aj: x, bi: pb, bj: y });
    pa = x + 1;
    pb = y + 1;
  }
  if (raw.length === 0) return [];

  // Merge hunks separated by little: spaces, punctuation, or one short word.
  const merged: typeof raw = [raw[0]];
  for (const h of raw.slice(1)) {
    const prev = merged[merged.length - 1];
    const gap = a.slice(prev.aj, h.ai);
    const words = gap.filter((u) => u.kind === "word");
    const hasToken = gap.some((u) => u.kind === "token");
    if (!hasToken && words.length <= 1 && words.every((w) => w.text.length <= 3)) {
      prev.aj = h.aj;
      prev.bj = h.bj;
    } else merged.push(h);
  }

  const pos = (units: typeof a, idx: number, text: string) => (idx < units.length ? units[idx].start : text.length);
  return merged.map((h) => {
    let fs = pos(a, h.ai, find);
    let fe = pos(a, h.aj, find);
    let rs = pos(b, h.bi, replace);
    let re = pos(b, h.bj, replace);
    // Keep shared leading/trailing whitespace out of the change.
    while (fs < fe && rs < re && find[fs] === replace[rs] && /\s/.test(find[fs])) {
      fs++;
      rs++;
    }
    while (fe > fs && re > rs && find[fe - 1] === replace[re - 1] && /\s/.test(find[fe - 1])) {
      fe--;
      re--;
    }
    return { fs, fe, rs, re };
  });
}

function stripMarkup(s: string): string {
  return s.replace(/\{\+\+|\+\+\}|\{--[\s\S]*?--\}/g, "");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function head(s: string, n: number): string {
  return s.slice(0, n);
}

function tail(s: string, n: number): string {
  return s.slice(Math.max(0, s.length - n));
}


/**
 * Tool arguments to operations. Accepts snake_case or camelCase keys; an
 * edit without `op` is a replace. Values are not validated here: the engine
 * reports problems per edit.
 */
export function parseEditOps(raw: unknown): EditOp[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
  return raw.map((item): EditOp => {
    const e = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const reason = str(e.reason);
    const op = str(e.op) ?? "replace";
    const block = str(e.block ?? e.block_id ?? e.blockId);
    if (op === "insert") {
      const paragraphs = Array.isArray(e.paragraphs)
        ? e.paragraphs.map((p) => str(p) ?? "")
        : str(e.text) !== undefined
          ? str(e.text)!.split(/\n{2,}/)
          : [];
      return { op, after: str(e.after), before: str(e.before), paragraphs, style: str(e.style), reason };
    }
    if (op === "delete") return { op, block: block!, through: str(e.through), reason };
    if (op === "replace") return { op, block: block!, find: str(e.find)!, replace: str(e.replace)!, reason };
    return { op } as unknown as EditOp;
  });
}
