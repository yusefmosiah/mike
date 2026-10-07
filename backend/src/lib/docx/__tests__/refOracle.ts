// REF-field oracle: Word caches the rendered paragraph number of a REF
// field's target in the field result. Comparing that cached text to the label
// we compute for the bookmarked paragraph measures our numbering against
// Word itself.

import { DocxDocument, visibleText, type Inline, type ParagraphBlock } from "../view";

export type RefSwitch = "w" | "r" | "n";

export interface RefCase {
  bookmark: string;
  switch: RefSwitch;
  instr: string;
  /** Word's cached result. */
  expected: string;
  /** Our computed label for the target paragraph (full context). */
  computed: string | undefined;
  /** Paragraph the REF field sits in. */
  from: ParagraphBlock;
  target: ParagraphBlock | undefined;
}

function* fields(inlines: readonly Inline[]): Generator<{ instr: string; result: Inline[] }> {
  for (const inline of inlines) {
    if (inline.t === "field") {
      yield inline;
      yield* fields(inline.result);
    } else if (inline.t === "link" || inline.t === "sdt" || inline.t === "rev") {
      yield* fields(inline.content);
    }
  }
}

export function refCases(doc: DocxDocument): RefCase[] {
  const out: RefCase[] = [];
  for (const p of doc.paragraphs) {
    for (const f of fields(p.inlines)) {
      const m = /^REF\s+(\S+)(.*)$/i.exec(f.instr);
      if (!m) continue;
      const sw = /\\([wrn])\b/i.exec(m[2]);
      if (!sw) continue;
      const target = doc.paragraphs.find((q) => q.id === doc.bookmarks.get(m[1]));
      out.push({
        bookmark: m[1],
        switch: sw[1].toLowerCase() as RefSwitch,
        instr: f.instr,
        expected: visibleText(f.result).trim(),
        computed: target?.label,
        from: p,
        target,
      });
    }
  }
  return out;
}
