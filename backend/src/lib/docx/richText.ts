// Text an edit inserts: plain text with a small markup for what cannot be
// typed as characters.
//
//   **bold**  *italic*           run formatting
//   [text](https://…)  [text](#bookmark)   a new hyperlink
//   {footnote: text}             a new footnote at this point
//   \* \[ \{ \\                   a literal character
//
// Tabs and line breaks become w:tab and w:br. The builder writes the runs
// as tracked insertions: runs sit inside w:ins, a hyperlink holds its own
// w:ins (a hyperlink may not sit inside one), and a footnote reference is
// an inserted run whose note text the caller writes into the notes part.

import { applyRunFormat, propItemsFromXml, propsXml, type PropItem } from "./props";
import { encodeXmlText } from "./xmlSource";

export type RichSegment =
  | { t: "text"; text: string; bold: boolean; italic: boolean }
  | { t: "link"; target: string; segments: RichSegment[] }
  | { t: "footnote"; segments: RichSegment[] };

export class RichTextError extends Error {}

const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)/;

/** Parse inserted text into segments. Links and footnotes do not nest. */
export function parseRich(s: string, allow: { footnote: boolean; link: boolean } = { footnote: true, link: true }): RichSegment[] {
  const out: RichSegment[] = [];
  let bold = false;
  let italic = false;
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", text: buf, bold, italic });
    buf = "";
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length && "*[]{}\\".includes(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (s.startsWith("{footnote:", i)) {
      if (!allow.footnote) throw new RichTextError("A footnote cannot contain another footnote.");
      let depth = 1;
      let j = i + 1;
      for (; j < s.length && depth; j++) {
        if (s[j] === "{") depth++;
        else if (s[j] === "}") depth--;
      }
      if (depth) throw new RichTextError('A "{footnote: …}" is missing its closing "}".');
      const inner = s.slice(i + "{footnote:".length, j - 1).trim();
      if (!inner) throw new RichTextError("A new footnote needs text: {footnote: The text of the note.}");
      flush();
      out.push({ t: "footnote", segments: parseRich(inner, { footnote: false, link: true }) });
      i = j;
      continue;
    }
    if (ch === "[") {
      const m = s.slice(i).match(LINK);
      if (m) {
        if (!allow.link) throw new RichTextError("A link cannot contain another link.");
        flush();
        const inner = parseRich(m[1], { footnote: false, link: false }).map((seg) =>
          seg.t === "text" ? { ...seg, bold: seg.bold || bold, italic: seg.italic || italic } : seg,
        );
        out.push({ t: "link", target: m[2], segments: inner });
        i += m[0].length;
        continue;
      }
    }
    if (s.startsWith("**", i)) {
      if (bold || s.indexOf("**", i + 2) !== -1) {
        flush();
        bold = !bold;
        i += 2;
        continue;
      }
    } else if (ch === "*") {
      if (italic || hasSingleStar(s, i + 1)) {
        flush();
        italic = !italic;
        i += 1;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

function hasSingleStar(s: string, from: number): boolean {
  for (let k = from; k < s.length; k++) {
    if (s[k] === "\\") {
      k++;
      continue;
    }
    if (s[k] === "*") {
      if (s[k + 1] === "*") {
        k++;
        continue;
      }
      return true;
    }
  }
  return false;
}

/** Plain text of segments, as a reader sees it (footnotes omitted). */
export function plainText(segments: RichSegment[]): string {
  return segments.map((s) => (s.t === "text" ? s.text : s.t === "link" ? plainText(s.segments) : "")).join("");
}

/** True when the text uses any markup (so it is more than plain characters). */
export function hasMarkup(segments: RichSegment[]): boolean {
  return segments.some((s) => s.t !== "text" || s.bold || s.italic);
}

export interface RichContext {
  /** Base run properties for new text, as "<w:rPr>…</w:rPr>" or "". */
  rPr: string;
  /** Opening tag of a new w:ins (allocates a revision id). */
  openIns: () => string;
  /** Attributes for a new w:hyperlink (relationship id or anchor). */
  link: (target: string) => string;
  /** Run properties for link text, given the base items. */
  linkStyle: (items: PropItem[]) => PropItem[];
  /** Write a new note with this content; returns its w:id. */
  footnote: (segments: RichSegment[]) => string;
  /** Run properties of a footnote reference mark. */
  noteRefRPr: string;
  /** The insertion point is inside a hyperlink, so no new link may start here. */
  insideLink?: boolean;
}

/** Runs for one text segment: tabs and line breaks become w:tab and w:br. */
export function textRuns(rPr: string, text: string): string {
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
  return body ? `<w:r>${rPr}${body}</w:r>` : "";
}

/** Inserted content as tracked-insertion XML. */
export function buildInserted(segments: RichSegment[], ctx: RichContext): string {
  const base = propItemsFromXml(ctx.rPr);
  const runFor = (seg: Extract<RichSegment, { t: "text" }>, items: PropItem[]) =>
    textRuns(propsXml("w:rPr", applyRunFormat(items, { bold: seg.bold || undefined, italic: seg.italic || undefined })), seg.text);
  let out = "";
  let open = "";
  const closeGroup = () => {
    if (open) out += `${ctx.openIns()}${open}</w:ins>`;
    open = "";
  };
  for (const seg of segments) {
    if (seg.t === "text") open += runFor(seg, base);
    else if (seg.t === "footnote") {
      const id = ctx.footnote(seg.segments);
      open += `<w:r>${ctx.noteRefRPr}<w:footnoteReference w:id="${id}"/></w:r>`;
    } else {
      if (ctx.insideLink) throw new RichTextError("A new link cannot go inside an existing link.");
      closeGroup();
      const style = ctx.linkStyle(base);
      const runs = seg.segments.map((s) => (s.t === "text" ? runFor(s, style) : "")).join("");
      if (runs) out += `<w:hyperlink ${ctx.link(seg.target)}>${ctx.openIns()}${runs}</w:ins></w:hyperlink>`;
    }
  }
  closeGroup();
  return out;
}
