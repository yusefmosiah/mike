// Accept or reject tracked changes, by revision id or all at once.
//
// Covers run-level insertions and deletions (and moves), paragraph-mark
// revisions (a removed mark merges its paragraph into the next one),
// table-row and table-cell revisions, inserted numbering, and recorded
// property changes (rPrChange, pPrChange, ...). Each part is rewritten
// through XmlPatch, so XML that holds no affected revision is unchanged.

import { DocxPackage, MAIN_DOCUMENT_PART, REL } from "./package";
import { XmlPatch } from "./patch";
import { childElements, documentElement, type XmlElement, type XmlSource } from "./xmlSource";

export type RevisionMode = "accept" | "reject";

export interface ResolveResult {
  bytes: Buffer;
  /** Revision ids that were found and resolved. */
  found: Set<string>;
}

const RUN_INSERT = new Set(["w:ins", "w:moveTo"]);
const RUN_DELETE = new Set(["w:del", "w:moveFrom"]);
const MARKERS = new Set(["w:ins", "w:del", "w:moveFrom", "w:moveTo"]);
const RANGE_MARKERS = new Set([
  "w:moveFromRangeStart",
  "w:moveFromRangeEnd",
  "w:moveToRangeStart",
  "w:moveToRangeEnd",
  "w:customXmlInsRangeStart",
  "w:customXmlInsRangeEnd",
  "w:customXmlDelRangeStart",
  "w:customXmlDelRangeEnd",
  "w:customXmlMoveFromRangeStart",
  "w:customXmlMoveFromRangeEnd",
  "w:customXmlMoveToRangeStart",
  "w:customXmlMoveToRangeEnd",
]);

/**
 * Property-change records and how rejecting one restores the old
 * properties: children of the parent named in `keep` stay (they are
 * revision markers or references, not properties); the rest are replaced
 * by the recorded ones, which go after the leading kept children.
 */
const PROPERTY_CHANGES: Record<string, { leading: string[]; trailing: string[] }> = {
  "w:rPrChange": { leading: ["w:ins", "w:del", "w:moveFrom", "w:moveTo"], trailing: [] },
  "w:pPrChange": { leading: [], trailing: ["w:rPr", "w:sectPr"] },
  "w:sectPrChange": { leading: ["w:headerReference", "w:footerReference"], trailing: [] },
  "w:tblPrChange": { leading: [], trailing: [] },
  "w:trPrChange": { leading: [], trailing: ["w:ins", "w:del"] },
  "w:tcPrChange": { leading: [], trailing: ["w:cellIns", "w:cellDel", "w:cellMerge"] },
  "w:tblGridChange": { leading: [], trailing: [] },
  "w:tblPrExChange": { leading: [], trailing: [] },
};

/** Parts that can hold tracked changes. */
function revisionParts(pkg: DocxPackage): string[] {
  return pkg
    .partNames()
    .filter((p) => /^word\/[^/]+\.xml$/i.test(p) && !/^word\/(settings|webSettings|fontTable)\.xml$/i.test(p))
    .filter((p) => /<w:(ins|del|moveFrom|moveTo|cellIns|cellDel|\w+Change)\b/.test(pkg.text(p) ?? ""));
}

export async function resolveRevisions(
  bytes: Buffer,
  mode: RevisionMode,
  ids?: Iterable<string>,
): Promise<ResolveResult> {
  const pkg = await DocxPackage.load(bytes);
  const found = resolveInPackage(pkg, mode, ids);
  return { bytes: await pkg.save(), found };
}

/** Resolve revisions in place on a loaded package. */
export function resolveInPackage(pkg: DocxPackage, mode: RevisionMode, ids?: Iterable<string>): Set<string> {
  const selected = ids === undefined ? undefined : new Set([...ids].map(String));
  const found = new Set<string>();
  const refsBefore = { footnote: noteRefs(pkg, "footnote"), endnote: noteRefs(pkg, "endnote") };
  for (const part of revisionParts(pkg)) {
    const text = resolveInPart(pkg.xml(part)!, mode, selected, found);
    if (text !== undefined) pkg.setText(part, text);
  }
  // A note whose reference went away with a resolved change goes too, as in Word.
  for (const kind of ["footnote", "endnote"] as const) {
    const after = noteRefs(pkg, kind);
    const gone = [...refsBefore[kind]].filter((id) => !after.has(id));
    if (gone.length) removeNotes(pkg, kind, new Set(gone));
  }
  return found;
}

function noteRefs(pkg: DocxPackage, kind: "footnote" | "endnote"): Set<string> {
  const out = new Set<string>();
  const re = new RegExp(`<w:${kind}Reference\\b[^>]*?\\bw:id="(-?\\d+)"`, "g");
  for (const part of pkg.partNames()) {
    if (!/^word\/[^/]+\.xml$/i.test(part)) continue;
    for (const m of (pkg.text(part) ?? "").matchAll(re)) out.add(m[1]);
  }
  return out;
}

function removeNotes(pkg: DocxPackage, kind: "footnote" | "endnote", ids: Set<string>): void {
  const part = pkg.relatedPart(MAIN_DOCUMENT_PART, kind === "footnote" ? REL.footnotes : REL.endnotes);
  const xml = part ? pkg.xml(part) : undefined;
  if (!part || !xml) return;
  const patch = new XmlPatch(xml);
  for (const note of childElements(documentElement(xml), `w:${kind}`)) {
    if (note.attrs["w:type"]) continue; // separators
    if (ids.has(note.attrs["w:id"] ?? "")) patch.remove(note);
  }
  if (!patch.isEmpty) pkg.setText(part, patch.toString());
}

/** Returns the rewritten part, or undefined when nothing in it was selected. */
export function resolveInPart(
  doc: XmlSource,
  mode: RevisionMode,
  selected: ReadonlySet<string> | undefined,
  found: Set<string>,
): string | undefined {
  const patch = new XmlPatch(doc);
  const removedMarks: XmlElement[] = [];
  const removedRows = new Set<XmlElement>();
  const accept = mode === "accept";

  const isSelected = (el: XmlElement): boolean => {
    const id = el.attrs["w:id"];
    if (selected === undefined) {
      if (id !== undefined) found.add(id);
      return true;
    }
    if (id !== undefined && selected.has(id)) {
      found.add(id);
      return true;
    }
    return false;
  };

  const walk = (el: XmlElement) => {
    for (const c of el.children) {
      if (c.kind !== "element") continue;
      const name = c.name;
      const parent = el.name;

      if (MARKERS.has(name) && (parent === "w:rPr" || parent === "w:trPr" || parent === "w:numPr")) {
        if (!isSelected(c)) continue;
        const inserted = RUN_INSERT.has(name);
        patch.remove(c);
        if (parent === "w:rPr" && el.parent?.name === "w:pPr") {
          // Paragraph mark: removed on accept-delete / reject-insert.
          if (inserted !== accept) removedMarks.push(el.parent.parent!);
        } else if (parent === "w:trPr") {
          if (inserted !== accept) {
            const row = el.parent!;
            patch.remove(row);
            removedRows.add(row);
          }
        } else if (parent === "w:numPr") {
          if (inserted && !accept) patch.remove(el);
        }
        continue;
      }

      if (RUN_INSERT.has(name) || RUN_DELETE.has(name)) {
        if (!isSelected(c)) {
          walk(c);
          continue;
        }
        const keep = RUN_INSERT.has(name) === accept;
        if (keep) {
          patch.unwrap(c);
          if (RUN_DELETE.has(name)) renameDeleted(c, patch);
          walk(c);
        } else {
          patch.remove(c);
        }
        continue;
      }

      if (name === "w:cellIns" || name === "w:cellDel") {
        if (!isSelected(c)) continue;
        patch.remove(c);
        const removeCell = (name === "w:cellIns") !== accept;
        if (removeCell && el.parent) patch.remove(el.parent);
        continue;
      }
      if (name === "w:cellMerge") {
        if (!isSelected(c)) continue;
        patch.remove(c);
        if (accept) {
          // A tracked vertical merge becomes a real one.
          const vMerge = c.attrs["w:vMerge"] === "rest" ? '<w:vMerge w:val="restart"/>' : "<w:vMerge/>";
          const anchor = [...el.children]
            .reverse()
            .find((k): k is XmlElement => k.kind === "element" && /^w:(tcW|gridSpan|hMerge)$/.test(k.name));
          if (anchor) patch.insertAfter(anchor, vMerge);
          else patch.prepend(el, vMerge);
        }
        continue;
      }

      if (name in PROPERTY_CHANGES) {
        if (!isSelected(c)) continue;
        if (accept) patch.remove(c);
        else restoreProperties(c, patch);
        continue;
      }
      if (name === "w:numberingChange") {
        if (isSelected(c)) patch.remove(c);
        continue;
      }

      if (RANGE_MARKERS.has(name)) {
        if (selected === undefined || isSelected(c)) patch.remove(c);
        continue;
      }

      walk(c);
    }
  };

  walk(documentElement(doc));

  // Tables left without rows go away entirely.
  const tables = new Set<XmlElement>();
  for (const row of removedRows) {
    let t = row.parent;
    while (t && t.name !== "w:tbl") t = t.parent;
    if (t) tables.add(t);
  }
  for (const t of tables) {
    if (rowsOf(t).every((r) => patch.isGone(r))) patch.remove(t);
  }

  // Hyperlinks whose runs all went away go too.
  const runs = (el: XmlElement, live: boolean): boolean =>
    el.children.some((c) => c.kind === "element" && (live && patch.isGone(c) ? false : c.name === "w:r" || runs(c, live)));
  const links = (el: XmlElement) => {
    for (const c of el.children) {
      if (c.kind !== "element") continue;
      if (c.name === "w:hyperlink" && !patch.isGone(c) && runs(c, false) && !runs(c, true)) patch.remove(c);
      else links(c);
    }
  };
  links(documentElement(doc));

  // Paragraph merges, in document order so chains resolve front to back.
  removedMarks.sort((a, b) => a.start - b.start);
  const willHaveContent = new Map<XmlElement, boolean>();
  const contentOf = (p: XmlElement) => willHaveContent.get(p) ?? hasContent(p, patch);
  for (const p of removedMarks) {
    if (patch.isGone(p)) continue;
    const next = nextParagraph(p);
    const ownContent = contentOf(p);
    if (!next || patch.isGone(next)) {
      // Nothing to merge into (end of a container, or a table follows):
      // an empty paragraph disappears; one with text keeps its place.
      if (!ownContent) patch.remove(p);
      continue;
    }
    patch.mergeParagraph(p, next, ownContent);
    willHaveContent.set(next, ownContent || hasContent(next, patch));
  }

  if (patch.isEmpty) return undefined;
  return patch.toString();
}

function rowsOf(tbl: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  const visit = (el: XmlElement) => {
    for (const c of el.children) {
      if (c.kind !== "element") continue;
      if (c.name === "w:tr") out.push(c);
      else if (c.name === "w:sdt" || c.name === "w:sdtContent" || c.name === "w:customXml") visit(c);
    }
  };
  visit(tbl);
  return out;
}

/** The paragraph that directly follows `p` in its container, if the next block is one. */
function nextParagraph(p: XmlElement): XmlElement | undefined {
  const siblings = p.parent!.children;
  let i = siblings.indexOf(p) + 1;
  for (; i < siblings.length; i++) {
    const s = siblings[i];
    if (s.kind !== "element") continue;
    if (s.name === "w:p") return s;
    if (INVISIBLE_BETWEEN.has(s.name)) continue;
    return undefined;
  }
  return undefined;
}

const INVISIBLE_BETWEEN = new Set(["w:bookmarkStart", "w:bookmarkEnd", "w:commentRangeStart", "w:commentRangeEnd", "w:proofErr", "w:permStart", "w:permEnd"]);

/** Whether a paragraph still has run content once the patch is applied. */
function hasContent(p: XmlElement, patch: XmlPatch): boolean {
  const visit = (el: XmlElement): boolean => {
    for (const c of el.children) {
      if (c.kind !== "element") continue;
      if (c.name === "w:pPr") continue;
      if (patch.isGone(c)) continue;
      if (c.name === "w:r") {
        if (c.children.some((k) => k.kind === "element" && k.name !== "w:rPr")) return true;
        continue;
      }
      if (visit(c)) return true;
    }
    return false;
  };
  return visit(p);
}

function renameDeleted(el: XmlElement, patch: XmlPatch): void {
  for (const c of el.children) {
    if (c.kind !== "element") continue;
    if (c.name === "w:delText") patch.rename(c, "w:t");
    else if (c.name === "w:delInstrText") patch.rename(c, "w:instrText");
    else renameDeleted(c, patch);
  }
}

/** Reject a property change: put the recorded properties back. */
function restoreProperties(change: XmlElement, patch: XmlPatch): void {
  const parent = change.parent!;
  const rule = PROPERTY_CHANGES[change.name];
  const recorded = change.children.find((c): c is XmlElement => c.kind === "element");
  const old = recorded ? inner(patch.doc, recorded) : "";
  let lastLeading: XmlElement | undefined;
  for (const c of parent.children) {
    if (c.kind !== "element" || c === change) continue;
    if (rule.leading.includes(c.name)) lastLeading = c;
    else if (!rule.trailing.includes(c.name)) patch.remove(c);
  }
  patch.remove(change);
  if (!old) return;
  if (lastLeading) patch.insertAfter(lastLeading, old);
  else patch.prepend(parent, old);
}

function inner(doc: XmlSource, el: XmlElement): string {
  return el.contentStart === el.end ? "" : doc.source.slice(el.contentStart, el.contentEnd);
}
