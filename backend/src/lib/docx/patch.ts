// Structural edits to a scanned XML part that leave untouched XML alone.
//
// Operations are recorded against elements of an XmlSource. Serializing
// re-emits only the elements on a path to an operation; every other subtree
// is copied from its source slice, so a part with one edited paragraph
// differs from the original only inside that paragraph.

import type { XmlElement, XmlNode, XmlSource } from "./xmlSource";

interface Ops {
  remove?: boolean;
  replace?: string;
  unwrap?: boolean;
  rename?: string;
  before?: string[];
  after?: string[];
  /** Inserted right after the start tag (before the first child). */
  prepend?: string[];
  /** Inserted right before the end tag (after the last child). */
  append?: string[];
  /** Paragraphs whose content is moved to the start of this one (mark removed). */
  mergedFrom?: XmlElement[];
  /** Use this paragraph's w:pPr instead of our own (set by a merge). */
  pPrFrom?: XmlElement;
}

export class XmlPatch {
  readonly doc: XmlSource;
  private readonly ops = new Map<XmlElement, Ops>();

  constructor(doc: XmlSource) {
    this.doc = doc;
  }

  private at(el: XmlElement): Ops {
    let o = this.ops.get(el);
    if (!o) {
      o = {};
      this.ops.set(el, o);
    }
    return o;
  }

  get isEmpty(): boolean {
    return this.ops.size === 0;
  }

  remove(el: XmlElement): void {
    this.at(el).remove = true;
  }

  replace(el: XmlElement, xml: string): void {
    this.at(el).replace = xml;
  }

  /** Emit the element's children without its own tags. */
  unwrap(el: XmlElement): void {
    this.at(el).unwrap = true;
  }

  rename(el: XmlElement, name: string): void {
    this.at(el).rename = name;
  }

  insertBefore(el: XmlElement, xml: string): void {
    (this.at(el).before ??= []).push(xml);
  }

  insertAfter(el: XmlElement, xml: string): void {
    (this.at(el).after ??= []).push(xml);
  }

  prepend(el: XmlElement, xml: string): void {
    (this.at(el).prepend ??= []).push(xml);
  }

  append(el: XmlElement, xml: string): void {
    (this.at(el).append ??= []).push(xml);
  }

  /**
   * Remove paragraph `from` and move its content (everything but w:pPr) to
   * the start of paragraph `into`, as Word does when a paragraph mark goes
   * away. With `keepFromProperties`, the merged paragraph keeps `from`'s
   * paragraph properties.
   */
  mergeParagraph(from: XmlElement, into: XmlElement, keepFromProperties: boolean): void {
    this.at(from).remove = true;
    const o = this.at(into);
    (o.mergedFrom ??= []).push(from);
    if (keepFromProperties) o.pPrFrom = this.ops.get(from)?.pPrFrom ?? from;
  }

  /** True when the element or an ancestor is removed or replaced. */
  isGone(el: XmlElement): boolean {
    for (let e: XmlElement | null = el; e; e = e.parent) {
      const o = this.ops.get(e);
      if (o && (o.remove || o.replace !== undefined)) return true;
    }
    return false;
  }

  toString(): string {
    const dirty = new Set<XmlElement>();
    for (const el of this.ops.keys()) {
      for (let e: XmlElement | null = el; e; e = e.parent) {
        if (dirty.has(e)) break;
        dirty.add(e);
      }
    }
    // Merged paragraphs are serialized inside their target, so their
    // subtrees must be walked even though they are marked removed.
    for (const o of this.ops.values()) {
      for (const from of o.mergedFrom ?? []) dirty.add(from);
      if (o.pPrFrom) dirty.add(o.pPrFrom);
    }
    const src = this.doc.source;
    if (dirty.size === 0) return src;
    const root = this.doc.root;
    // The synthetic root spans the whole part, prolog included.
    return this.children(root, src, dirty, 0, src.length);
  }

  private children(el: XmlElement, src: string, dirty: Set<XmlElement>, from: number, to: number): string {
    let out = "";
    let cursor = from;
    for (const c of el.children) {
      if (c.kind !== "element") continue;
      if (!dirty.has(c)) continue;
      out += src.slice(cursor, c.start);
      out += this.element(c, src, dirty);
      cursor = c.end;
    }
    out += src.slice(cursor, to);
    return out;
  }

  private element(el: XmlElement, src: string, dirty: Set<XmlElement>): string {
    const o = this.ops.get(el);
    const before = o?.before?.join("") ?? "";
    const after = o?.after?.join("") ?? "";
    if (o?.remove) return before + after;
    if (o?.replace !== undefined) return before + o.replace + after;
    return before + this.body(el, src, dirty) + after;
  }

  /** The element itself (or its unwrapped content), with descendant ops applied. */
  private body(el: XmlElement, src: string, dirty: Set<XmlElement>): string {
    const o = this.ops.get(el);
    const inner = this.content(el, src, dirty);
    if (o?.unwrap) return inner;
    const selfClosing = el.contentStart === el.end;
    const name = o?.rename ?? el.name;
    const startTag = o?.rename
      ? `<${name}${src.slice(el.start + 1 + el.name.length, selfClosing ? el.end - 2 : el.contentStart - 1)}`
      : src.slice(el.start, selfClosing ? el.end - 2 : el.contentStart - 1);
    if (selfClosing && inner === "") return `${startTag.trimEnd()}/>`;
    const endTag = selfClosing ? `</${name}>` : o?.rename ? `</${name}>` : src.slice(el.contentEnd, el.end);
    return `${startTag}>${inner}${endTag}`;
  }

  private content(el: XmlElement, src: string, dirty: Set<XmlElement>): string {
    const o = this.ops.get(el);
    let inner = o?.prepend?.join("") ?? "";
    const merged = o?.mergedFrom?.length ? o.mergedFrom.map((p) => this.paragraphContent(p, src, dirty)).join("") : "";
    const pPrSource = o?.pPrFrom;
    if (!merged && !pPrSource) {
      inner += dirty.has(el) ? this.children(el, src, dirty, el.contentStart, el.contentEnd) : src.slice(el.contentStart, el.contentEnd);
    } else {
      // Paragraph receiving merged content: [pPr] merged... own content.
      const ownPPr = firstElement(el, "w:pPr");
      const pPr = pPrSource ? firstElement(pPrSource, "w:pPr") : ownPPr;
      if (pPr) inner += this.body(pPr, src, dirty);
      inner += merged;
      inner += this.childrenExcept(el, ownPPr, src, dirty);
    }
    inner += o?.append?.join("") ?? "";
    return inner;
  }

  /** A merged paragraph's content: what was merged into it, then its own children minus w:pPr. */
  private paragraphContent(p: XmlElement, src: string, dirty: Set<XmlElement>): string {
    const o = this.ops.get(p);
    let out = o?.prepend?.join("") ?? "";
    if (o?.mergedFrom) out += o.mergedFrom.map((m) => this.paragraphContent(m, src, dirty)).join("");
    out += this.childrenExcept(p, firstElement(p, "w:pPr"), src, dirty);
    out += o?.append?.join("") ?? "";
    return out;
  }

  private childrenExcept(el: XmlElement, skip: XmlElement | undefined, src: string, dirty: Set<XmlElement>): string {
    let out = "";
    for (const c of el.children) {
      if (c === skip) continue;
      out += this.node(c, src, dirty);
    }
    return out;
  }

  private node(n: XmlNode, src: string, dirty: Set<XmlElement>): string {
    if (n.kind === "text") return src.slice(n.start, n.end);
    if (!dirty.has(n)) return src.slice(n.start, n.end);
    return this.element(n, src, dirty);
  }
}

function firstElement(el: XmlElement, name: string): XmlElement | undefined {
  for (const c of el.children) if (c.kind === "element" && c.name === name) return c;
  return undefined;
}
