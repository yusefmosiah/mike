// Run and paragraph property lists (w:rPr, w:pPr) as editable lists of
// child elements, written back in the order the schema requires. Word
// rejects a document whose property children are out of order, so every
// change to formatting goes through here.

import { childElements, encodeXmlAttr, sliceOf, type XmlElement, type XmlSource } from "./xmlSource";

/** CT_RPr child order (revision markers first for a paragraph mark's rPr). */
const RPR_ORDER = [
  "w:ins",
  "w:del",
  "w:moveFrom",
  "w:moveTo",
  "w:rStyle",
  "w:rFonts",
  "w:b",
  "w:bCs",
  "w:i",
  "w:iCs",
  "w:caps",
  "w:smallCaps",
  "w:strike",
  "w:dstrike",
  "w:outline",
  "w:shadow",
  "w:emboss",
  "w:imprint",
  "w:noProof",
  "w:snapToGrid",
  "w:vanish",
  "w:webHidden",
  "w:color",
  "w:spacing",
  "w:w",
  "w:kern",
  "w:position",
  "w:sz",
  "w:szCs",
  "w:highlight",
  "w:u",
  "w:effect",
  "w:bdr",
  "w:shd",
  "w:fitText",
  "w:vertAlign",
  "w:rtl",
  "w:cs",
  "w:em",
  "w:lang",
  "w:eastAsianLayout",
  "w:specVanish",
  "w:oMath",
  "w:rPrChange",
];

/** CT_PPr child order. */
const PPR_ORDER = [
  "w:pStyle",
  "w:keepNext",
  "w:keepLines",
  "w:pageBreakBefore",
  "w:framePr",
  "w:widowControl",
  "w:numPr",
  "w:suppressLineNumbers",
  "w:pBdr",
  "w:shd",
  "w:tabs",
  "w:suppressAutoHyphens",
  "w:kinsoku",
  "w:wordWrap",
  "w:overflowPunct",
  "w:topLinePunct",
  "w:autoSpaceDE",
  "w:autoSpaceDN",
  "w:bidi",
  "w:adjustRightInd",
  "w:snapToGrid",
  "w:spacing",
  "w:ind",
  "w:contextualSpacing",
  "w:mirrorIndents",
  "w:suppressOverlap",
  "w:jc",
  "w:textDirection",
  "w:textAlignment",
  "w:textboxTightWrap",
  "w:outlineLvl",
  "w:divId",
  "w:cnfStyle",
  "w:rPr",
  "w:sectPr",
  "w:pPrChange",
];

export interface PropItem {
  name: string;
  xml: string;
}

/** A property list's children as name + exact XML. */
export function propItems(src: XmlSource, el: XmlElement | undefined): PropItem[] {
  if (!el) return [];
  return childElements(el).map((c) => ({ name: c.name, xml: sliceOf(src, c) }));
}

/** Parse a property list given as an XML string (e.g. "<w:rPr>…</w:rPr>" or ""). */
export function propItemsFromXml(xml: string): PropItem[] {
  const out: PropItem[] = [];
  const inner = xml.replace(/^<w:[rp]Pr\b[^>]*>/, "").replace(/<\/w:[rp]Pr>$/, "");
  if (/^<w:[rp]Pr\b[^>]*\/>$/.test(xml) || !inner) return out;
  // Top-level children only: track depth through the string.
  let i = 0;
  while (i < inner.length) {
    const lt = inner.indexOf("<", i);
    if (lt === -1) break;
    const nameEnd = inner.slice(lt + 1).search(/[\s/>]/);
    const name = inner.slice(lt + 1, lt + 1 + nameEnd);
    const startEnd = inner.indexOf(">", lt);
    if (inner[startEnd - 1] === "/") {
      out.push({ name, xml: inner.slice(lt, startEnd + 1) });
      i = startEnd + 1;
      continue;
    }
    // Find the matching close tag, counting nested same-name elements.
    let depth = 1;
    let j = startEnd + 1;
    const open = new RegExp(`<${name}[\\s/>]`, "g");
    const close = `</${name}>`;
    while (depth > 0) {
      const c = inner.indexOf(close, j);
      open.lastIndex = j;
      const o = open.exec(inner);
      if (o && o.index < c) {
        const oEnd = inner.indexOf(">", o.index);
        if (inner[oEnd - 1] !== "/") depth++;
        j = oEnd + 1;
      } else {
        depth--;
        j = c + close.length;
      }
    }
    out.push({ name, xml: inner.slice(lt, j) });
    i = j;
  }
  return out;
}

/** Replace (or remove, with xml === undefined) the items named `names`, keeping schema order. */
export function setProp(items: PropItem[], names: string[], xml: string | undefined, kind: "r" | "p"): PropItem[] {
  const out = items.filter((it) => !names.includes(it.name));
  if (xml !== undefined) out.push({ name: names[0], xml });
  return sortProps(out, kind);
}

export function sortProps(items: PropItem[], kind: "r" | "p"): PropItem[] {
  const order = kind === "r" ? RPR_ORDER : PPR_ORDER;
  const rank = (n: string) => {
    const i = order.indexOf(n);
    return i === -1 ? order.length - 1.5 : i; // unknown elements just before the change record
  };
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => rank(a.it.name) - rank(b.it.name) || a.i - b.i)
    .map((x) => x.it);
}

export function propsXml(tag: "w:rPr" | "w:pPr" | "w:tcPr" | "w:trPr", items: PropItem[]): string {
  return items.length ? `<${tag}>${items.map((i) => i.xml).join("")}</${tag}>` : "";
}

/** Run formatting an edit can set. */
export interface RunFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Highlight colour name (e.g. "yellow"), or "none" to remove. */
  highlight?: string;
}

export const HIGHLIGHT_COLOURS = new Set([
  "black",
  "blue",
  "cyan",
  "green",
  "magenta",
  "red",
  "yellow",
  "white",
  "darkBlue",
  "darkCyan",
  "darkGreen",
  "darkMagenta",
  "darkRed",
  "darkYellow",
  "darkGray",
  "lightGray",
  "none",
]);

/** Apply run formatting to rPr items. */
export function applyRunFormat(items: PropItem[], fmt: RunFormat): PropItem[] {
  let out = items;
  const toggle = (on: boolean | undefined, names: string[]) => {
    if (on === undefined) return;
    out = setProp(out, names, on ? `<${names[0]}/>` : `<${names[0]} w:val="0"/>`, "r");
    // Complex-script twin follows the main property.
    if (names[1]) out = setProp(out, [names[1]], on ? `<${names[1]}/>` : `<${names[1]} w:val="0"/>`, "r");
  };
  toggle(fmt.bold, ["w:b", "w:bCs"]);
  toggle(fmt.italic, ["w:i", "w:iCs"]);
  if (fmt.strike !== undefined) {
    out = out.filter((i) => i.name !== "w:dstrike");
    out = setProp(out, ["w:strike"], fmt.strike ? "<w:strike/>" : '<w:strike w:val="0"/>', "r");
  }
  if (fmt.underline !== undefined) {
    out = setProp(out, ["w:u"], `<w:u w:val="${fmt.underline ? "single" : "none"}"/>`, "r");
  }
  if (fmt.highlight !== undefined) {
    out = setProp(out, ["w:highlight"], fmt.highlight === "none" ? undefined : `<w:highlight w:val="${encodeXmlAttr(fmt.highlight)}"/>`, "r");
  }
  return out;
}
