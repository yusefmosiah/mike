// Position-tracking XML scan for OOXML parts.
//
// The document model never re-serializes XML it did not change. To make that
// possible every element records the exact offsets of its source text, so an
// edit (Mission 1b) can replace one element's range and leave every other
// byte of the part untouched. Text is kept as offsets and decoded on demand.
//
// OOXML parts are well-formed XML without DTDs; anything else is rejected
// rather than guessed at.

export interface XmlElement {
  kind: "element";
  /** Qualified name as written, e.g. "w:p". */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  parent: XmlElement | null;
  /** Offset of the opening `<`. */
  start: number;
  /** Offset just past the closing `>` (of the end tag, or of a self-closing tag). */
  end: number;
  /** Offset just past the `>` of the start tag; equals `end` when self-closing. */
  contentStart: number;
  /** Offset of the end tag's `<`; equals `end` when self-closing. */
  contentEnd: number;
}

export interface XmlText {
  kind: "text";
  start: number;
  end: number;
  parent: XmlElement;
}

export type XmlNode = XmlElement | XmlText;

export interface XmlSource {
  /** The part exactly as read. */
  source: string;
  root: XmlElement;
}

export class XmlScanError extends Error {
  constructor(message: string, offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = "XmlScanError";
  }
}

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g;

export function decodeXmlText(raw: string): string {
  if (raw.indexOf("&") === -1) return raw;
  return raw.replace(ENTITY_RE, (_m, ent: string) => {
    switch (ent) {
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
        return String.fromCodePoint(
          ent[1] === "x" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10),
        );
    }
  });
}

export function encodeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function encodeXmlAttr(value: string): string {
  return encodeXmlText(value).replace(/"/g, "&quot;");
}

function isNameEnd(code: number): boolean {
  // whitespace, '/', '>'
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 47 || code === 62;
}

/** Scan a part into an offset-annotated element tree. */
export function scanXml(source: string): XmlSource {
  const len = source.length;
  // Synthetic root holding the document element (and nothing else we keep).
  const root: XmlElement = {
    kind: "element",
    name: "#root",
    attrs: {},
    children: [],
    parent: null,
    start: 0,
    end: len,
    contentStart: 0,
    contentEnd: len,
  };
  let current = root;
  let i = 0;

  while (i < len) {
    const lt = source.indexOf("<", i);
    const textEnd = lt === -1 ? len : lt;
    if (textEnd > i && current !== root) {
      current.children.push({ kind: "text", start: i, end: textEnd, parent: current });
    }
    if (lt === -1) break;
    i = lt;
    const next = source.charCodeAt(i + 1);

    if (next === 63 /* ? */) {
      const close = source.indexOf("?>", i + 2);
      if (close === -1) throw new XmlScanError("Unterminated processing instruction", i);
      i = close + 2;
      continue;
    }
    if (next === 33 /* ! */) {
      if (source.startsWith("<!--", i)) {
        const close = source.indexOf("-->", i + 4);
        if (close === -1) throw new XmlScanError("Unterminated comment", i);
        i = close + 3;
        continue;
      }
      if (source.startsWith("<![CDATA[", i)) {
        const close = source.indexOf("]]>", i + 9);
        if (close === -1) throw new XmlScanError("Unterminated CDATA section", i);
        if (current !== root) {
          current.children.push({ kind: "text", start: i, end: close + 3, parent: current });
        }
        i = close + 3;
        continue;
      }
      throw new XmlScanError("DTDs and declarations are not supported", i);
    }
    if (next === 47 /* / */) {
      const gt = source.indexOf(">", i + 2);
      if (gt === -1) throw new XmlScanError("Unterminated end tag", i);
      const name = source.slice(i + 2, gt).trim();
      if (current === root || name !== current.name) {
        throw new XmlScanError(`Mismatched end tag </${name}>`, i);
      }
      current.contentEnd = i;
      current.end = gt + 1;
      current = current.parent!;
      i = gt + 1;
      continue;
    }

    // Start tag.
    let p = i + 1;
    while (p < len && !isNameEnd(source.charCodeAt(p))) p++;
    const name = source.slice(i + 1, p);
    if (!name) throw new XmlScanError("Empty element name", i);
    const attrs: Record<string, string> = {};
    let selfClosing = false;
    for (;;) {
      while (p < len) {
        const c = source.charCodeAt(p);
        if (c === 32 || c === 9 || c === 10 || c === 13) p++;
        else break;
      }
      if (p >= len) throw new XmlScanError("Unterminated start tag", i);
      const c = source.charCodeAt(p);
      if (c === 62 /* > */) {
        p++;
        break;
      }
      if (c === 47 /* / */) {
        if (source.charCodeAt(p + 1) !== 62) throw new XmlScanError("Malformed self-closing tag", p);
        selfClosing = true;
        p += 2;
        break;
      }
      const eq = source.indexOf("=", p);
      if (eq === -1) throw new XmlScanError("Attribute without value", p);
      const attrName = source.slice(p, eq).trim();
      let q = eq + 1;
      while (source.charCodeAt(q) === 32 || source.charCodeAt(q) === 9 || source.charCodeAt(q) === 10 || source.charCodeAt(q) === 13) q++;
      const quote = source[q];
      if (quote !== '"' && quote !== "'") throw new XmlScanError("Unquoted attribute value", q);
      const closeQuote = source.indexOf(quote, q + 1);
      if (closeQuote === -1) throw new XmlScanError("Unterminated attribute value", q);
      attrs[attrName] = decodeXmlText(source.slice(q + 1, closeQuote));
      p = closeQuote + 1;
    }

    const el: XmlElement = {
      kind: "element",
      name,
      attrs,
      children: [],
      parent: current,
      start: i,
      end: selfClosing ? p : -1,
      contentStart: p,
      contentEnd: selfClosing ? p : -1,
    };
    current.children.push(el);
    if (!selfClosing) current = el;
    i = p;
  }

  if (current !== root) {
    throw new XmlScanError(`Unclosed element <${current.name}>`, current.start);
  }
  return { source, root };
}

/** The document element (first element child of the synthetic root). */
export function documentElement(doc: XmlSource): XmlElement {
  const el = doc.root.children.find((c): c is XmlElement => c.kind === "element");
  if (!el) throw new XmlScanError("Part has no document element", 0);
  return el;
}

export function childElements(el: XmlElement, name?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) {
    if (c.kind === "element" && (name === undefined || c.name === name)) out.push(c);
  }
  return out;
}

export function firstChild(el: XmlElement, name: string): XmlElement | undefined {
  for (const c of el.children) {
    if (c.kind === "element" && c.name === name) return c;
  }
  return undefined;
}

/** Decoded text content of a text node (CDATA unwrapped). */
export function textOf(doc: XmlSource, node: XmlText): string {
  const raw = doc.source.slice(node.start, node.end);
  if (raw.startsWith("<![CDATA[")) return raw.slice(9, -3);
  return decodeXmlText(raw);
}

/** Concatenated decoded text of an element's direct text children. */
export function ownText(doc: XmlSource, el: XmlElement): string {
  let s = "";
  for (const c of el.children) if (c.kind === "text") s += textOf(doc, c);
  return s;
}

/** Exact source of an element. */
export function sliceOf(doc: XmlSource, el: XmlElement): string {
  return doc.source.slice(el.start, el.end);
}
