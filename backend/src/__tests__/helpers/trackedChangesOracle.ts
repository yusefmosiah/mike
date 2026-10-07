// Canonical form of a .docx for comparing documents after accept/reject.
//
// Two documents are equivalent when they read the same and look the same at
// run level: the same blocks, paragraph styles and list membership, and the
// same characters with the same run properties. How text is split into runs,
// rsid attributes and element order inside property lists are ignored.

import {
  DocxDocument,
  type Block,
  type Inline,
  type ParagraphBlock,
} from "../../lib/docx/view";
import {
  firstChild,
  type XmlElement,
  type XmlSource,
} from "../../lib/docx/xmlSource";

export interface CanonicalOptions {
  /** Compare run properties (default true). */
  runProperties?: boolean;
  /** Compare paragraph properties beyond style and numbering (default false). */
  paragraphProperties?: boolean;
  /** Prefix each paragraph line with its block id. */
  ids?: boolean;
}

/** Canonical lines: one per paragraph (table cells indented), notes inline. */
export async function canonicalDocx(
  bytes: Buffer,
  opts: CanonicalOptions = {},
): Promise<string[]> {
  const doc = await DocxDocument.load(bytes);
  const lines: string[] = [];
  const src = (part: string) => doc.source(part);

  const props = (rPr: XmlElement | undefined, xml: XmlSource): string => {
    if (!rPr || opts.runProperties === false) return "";
    const items: string[] = [];
    for (const c of rPr.children) {
      if (c.kind !== "element") continue;
      if (
        /^w:(rPrChange|ins|del|moveFrom|moveTo|lang|noProof|rFonts|kern|szCs|bCs|iCs)$/.test(
          c.name,
        )
      )
        continue;
      items.push(canonicalElement(xml, c));
    }
    return items.sort().join("");
  };

  const inlines = (top: readonly Inline[], part: string): string => {
    let out = "";
    let fmt = "\u0000";
    const open = (f: string) => {
      if (f !== fmt) {
        out += `⟨${f}⟩`;
        fmt = f;
      }
    };
    // Content controls are transparent: their text continues the stream.
    const visit = (list: readonly Inline[]) => {
      for (const i of list) {
        switch (i.t) {
          case "text":
            open(props(firstChild(i.run, "w:rPr"), src(part)));
            out += i.text;
            break;
          case "tab":
            out += "→";
            break;
          case "break":
            out += i.kind === "line" ? "↵" : `{${i.kind}}`;
            break;
          case "note": {
            const note = (
              i.kind === "footnote" ? doc.footnotes : doc.endnotes
            ).get(i.id);
            const body = note
              ? note.paragraphs
                  .map((p) => inlines(p.inlines, p.part))
                  .join(" / ")
              : "?";
            out += `{${i.kind} ${body}}`;
            fmt = "\u0000";
            break;
          }
          case "sym":
            out += i.char ?? `{sym ${i.font} ${i.code}}`;
            break;
          case "field":
            out += `{field ${i.instr.split(/\s+/)[0]?.toUpperCase()}: ${inlines(i.result, part)}}`;
            fmt = "\u0000";
            break;
          case "link":
            out += `{link ${i.target ?? `#${i.anchor ?? ""}`}: ${inlines(i.content, part)}}`;
            fmt = "\u0000";
            break;
          case "rev":
            out += `{${i.kind}: ${inlines(i.content, part)}}`;
            fmt = "\u0000";
            break;
          case "sdt":
            visit(i.content);
            break;
          case "comment":
            out += `{comment}`;
            break;
          case "object":
            out += `{${i.kind}${i.textbox ? `: ${i.textbox.join(" / ")}` : ""}}`;
            break;
          default:
            break;
        }
      }
    };
    visit(top);
    return out;
  };

  const paragraph = (p: ParagraphBlock, indent: string) => {
    const pPr = firstChild(p.el, "w:pPr");
    const numPr = pPr && firstChild(pPr, "w:numPr");
    const head = [
      p.styleId ? `style=${p.styleId}` : "",
      numPr ? `num=${canonicalElement(src(p.part), numPr)}` : "",
      p.markRevision ? `mark=${p.markRevision}` : "",
      opts.paragraphProperties && pPr
        ? canonicalParagraphProps(src(p.part), pPr)
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(
      `${indent}${opts.ids ? `${p.id} ` : ""}¶${head ? `[${head}]` : ""} ${inlines(p.inlines, p.part)}`,
    );
  };

  const blocks = (list: readonly Block[], indent: string) => {
    for (const b of list) {
      if (b.kind === "paragraph") paragraph(b, indent);
      else if (b.kind === "table") {
        lines.push(`${indent}table`);
        b.rows.forEach((row, r) => {
          lines.push(
            `${indent}  row ${r + 1}${row.revision ? ` ${row.revision}` : ""}`,
          );
          row.cells.forEach((cell, c) => {
            lines.push(
              `${indent}    cell ${c + 1}${cell.gridSpan > 1 ? ` span=${cell.gridSpan}` : ""}${cell.vMerge ? ` vmerge=${cell.vMerge}` : ""}`,
            );
            blocks(cell.blocks, `${indent}      `);
          });
        });
      } else lines.push(`${indent}{${b.name}}`);
    }
  };

  blocks(doc.blocks, "");
  return lines;
}

/** An element with attributes sorted and rsids dropped, children canonical. */
export function canonicalElement(xml: XmlSource, el: XmlElement): string {
  const attrs = Object.entries(el.attrs)
    .filter(([k]) => !/rsid/i.test(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("");
  const kids = el.children
    .filter((c): c is XmlElement => c.kind === "element")
    .map((c) => canonicalElement(xml, c))
    .sort()
    .join("");
  return `<${el.name}${attrs}${kids ? `>${kids}</${el.name}>` : "/>"}`;
}

function canonicalParagraphProps(xml: XmlSource, pPr: XmlElement): string {
  return pPr.children
    .filter(
      (c): c is XmlElement =>
        c.kind === "element" &&
        !/^w:(rPr|pPrChange|sectPr|pStyle|numPr)$/.test(c.name),
    )
    .map((c) => canonicalElement(xml, c))
    .sort()
    .join("");
}
