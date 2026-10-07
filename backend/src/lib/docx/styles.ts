// Paragraph style resolution: the parts of styles.xml the view needs —
// display names, the basedOn chain, style-level numbering, and outline level.

import { childElements, documentElement, firstChild, type XmlSource } from "./xmlSource";

export interface NumberingRef {
  numId?: string;
  ilvl?: number;
}

export interface ParagraphStyle {
  id: string;
  name?: string;
  basedOn?: string;
  numPr?: NumberingRef;
  outlineLvl?: number;
}

export class StyleSheet {
  readonly styles = new Map<string, ParagraphStyle>();
  defaultParagraphStyleId?: string;

  constructor(xml: XmlSource | undefined) {
    if (!xml) return;
    for (const style of childElements(documentElement(xml), "w:style")) {
      if (style.attrs["w:type"] !== "paragraph") continue;
      const id = style.attrs["w:styleId"];
      if (!id) continue;
      const pPr = firstChild(style, "w:pPr");
      const numPrEl = pPr && firstChild(pPr, "w:numPr");
      const outline = pPr && firstChild(pPr, "w:outlineLvl");
      const entry: ParagraphStyle = {
        id,
        name: firstChild(style, "w:name")?.attrs["w:val"],
        basedOn: firstChild(style, "w:basedOn")?.attrs["w:val"],
        numPr: numPrEl ? readNumPr(numPrEl) : undefined,
        outlineLvl: outline ? parseIntOr(outline.attrs["w:val"]) : undefined,
      };
      this.styles.set(id, entry);
      if (style.attrs["w:default"] === "1" || style.attrs["w:default"] === "true") {
        this.defaultParagraphStyleId = id;
      }
    }
  }

  /** Style chain from the given style up through basedOn (cycle-safe). */
  chain(styleId: string | undefined): ParagraphStyle[] {
    const out: ParagraphStyle[] = [];
    const seen = new Set<string>();
    let id = styleId ?? this.defaultParagraphStyleId;
    while (id && !seen.has(id)) {
      seen.add(id);
      const style = this.styles.get(id);
      if (!style) break;
      out.push(style);
      id = style.basedOn;
    }
    return out;
  }

  /** Numbering inherited from the style chain; numId and ilvl resolve independently. */
  inheritedNumPr(styleId: string | undefined): NumberingRef | undefined {
    let numId: string | undefined;
    let ilvl: number | undefined;
    for (const style of this.chain(styleId)) {
      if (numId === undefined && style.numPr?.numId !== undefined) numId = style.numPr.numId;
      if (ilvl === undefined && style.numPr?.ilvl !== undefined) ilvl = style.numPr.ilvl;
    }
    return numId === undefined ? undefined : { numId, ilvl };
  }

  outlineLevel(styleId: string | undefined): number | undefined {
    for (const style of this.chain(styleId)) {
      if (style.outlineLvl !== undefined) return style.outlineLvl;
    }
    return undefined;
  }

  displayName(styleId: string | undefined): string | undefined {
    if (!styleId) return undefined;
    return this.styles.get(styleId)?.name ?? styleId;
  }
}

export function readNumPr(numPr: import("./xmlSource").XmlElement): NumberingRef {
  const numId = firstChild(numPr, "w:numId")?.attrs["w:val"];
  const ilvl = firstChild(numPr, "w:ilvl")?.attrs["w:val"];
  return {
    numId: numId ?? undefined,
    ilvl: ilvl !== undefined ? parseIntOr(ilvl) : undefined,
  };
}

export function parseIntOr(value: string | undefined, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}
