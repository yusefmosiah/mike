// The editable form of one paragraph: the exact line read_document shows
// for it, with every character mapped back to the XML it came from.
//
// A slot is a rendered range of that line:
//   text    characters of a w:t (or a tab, line break, symbol) that can be
//           deleted one by one and that inserted text can sit next to;
//   token   an atomic item ([^3], {ref 4.2}, {image}, {page break}) that can
//           be deleted whole but never split or typed;
//   markup  link and tracked-change brackets: not document text, and only
//           removable together with what they enclose;
//   frozen  an existing tracked deletion, which edits leave as it is.
// Field codes, empty runs and other invisible run children have no slot;
// they stay where they are unless a whole field is deleted.

import { renderInlines } from "./render";
import type { Inline, ParagraphBlock } from "./view";
import type { XmlElement } from "./xmlSource";

export interface Wrapper {
  kind: "link" | "ins" | "del" | "sdt" | "field" | "fldSimple";
  el?: XmlElement;
  /** Rendered extent, markup included. */
  start: number;
  end: number;
}

interface SlotBase {
  start: number;
  end: number;
  /** Enclosing wrappers, outermost first. */
  wrappers: Wrapper[];
}

export interface CharUnit {
  /** w:t, or a single-character run child (w:tab, w:br, w:sym, w:noBreakHyphen). */
  node: XmlElement;
  run: XmlElement;
  /** Character index within the w:t's decoded text; undefined for whole nodes. */
  index?: number;
}

export type Slot =
  | (SlotBase & { kind: "text"; unit: CharUnit })
  | (SlotBase & { kind: "token"; label: string; nodes: XmlElement[]; deletable: boolean; why?: string })
  | (SlotBase & { kind: "markup"; owner: Wrapper })
  | (SlotBase & { kind: "frozen"; owner: Wrapper });

export interface EditModel {
  paragraph: ParagraphBlock;
  /** Rendered body, identical to renderInlines(paragraph.inlines). */
  text: string;
  slots: Slot[];
  /** Fields whose result is ordinary editable text: deleting all of it deletes the field. */
  fields: { wrapper: Wrapper; nodes: XmlElement[] }[];
}

export function buildEditModel(p: ParagraphBlock): EditModel {
  const slots: Slot[] = [];
  const fields: EditModel["fields"] = [];
  let text = "";

  const push = (slot: Omit<SlotBase, "start" | "end"> & Record<string, unknown>, s: string) => {
    const start = text.length;
    text += s;
    slots.push({ ...slot, start, end: text.length } as Slot);
  };
  const markup = (s: string, owner: Wrapper, wrappers: Wrapper[]) => {
    if (s) push({ kind: "markup", owner, wrappers }, s);
  };

  const visit = (list: readonly Inline[], wrappers: Wrapper[]) => {
    for (const inline of list) {
      switch (inline.t) {
        case "text":
          if (inline.node.name === "w:t") {
            for (let i = 0; i < inline.text.length; i++) {
              push({ kind: "text", wrappers, unit: { node: inline.node, run: inline.run, index: i } }, inline.text[i]);
            }
          } else {
            // w:noBreakHyphen renders as one character.
            push({ kind: "text", wrappers, unit: { node: inline.node, run: inline.run } }, inline.text);
          }
          break;
        case "tab":
          push({ kind: "text", wrappers, unit: { node: inline.node, run: inline.run } }, "\t");
          break;
        case "break":
          if (inline.kind === "page") {
            push({ kind: "token", wrappers, label: "{page break}", nodes: [inline.node], deletable: true }, " {page break} ");
          } else {
            push({ kind: "text", wrappers, unit: { node: inline.node, run: inline.run } }, "\n");
          }
          break;
        case "note": {
          const s = inline.kind === "footnote" ? `[^${inline.mark}]` : `[^e${inline.mark}]`;
          push({ kind: "token", wrappers, label: s, nodes: [inline.node], deletable: true }, s);
          break;
        }
        case "noteMark":
          break;
        case "sym":
          if (inline.char !== undefined && inline.char.length > 0) {
            push({ kind: "text", wrappers, unit: { node: inline.node, run: inline.run } }, inline.char);
          } else {
            const s = renderInlines([inline]);
            push({ kind: "token", wrappers, label: s, nodes: [inline.node], deletable: true }, s);
          }
          break;
        case "field": {
          const name = inline.instr.split(/\s+/)[0]?.toUpperCase() ?? "";
          const nodes = inline.nodes ?? (inline.el ? fldSimpleNodes(inline.el) : []);
          if (name === "REF" || name === "NOTEREF") {
            const s = renderInlines([inline]);
            push({ kind: "token", wrappers, label: s, nodes, deletable: nodes.length > 0 }, s);
          } else {
            const wrapper: Wrapper = { kind: inline.el ? "fldSimple" : "field", el: inline.el, start: text.length, end: 0 };
            visit(inline.result, inline.el ? [...wrappers, wrapper] : wrappers);
            wrapper.end = text.length;
            fields.push({ wrapper, nodes });
          }
          break;
        }
        case "link": {
          const wrapper: Wrapper = { kind: "link", el: inline.el, start: text.length, end: 0 };
          const inner = [...wrappers, wrapper];
          if (inline.target) markup("[", wrapper, inner);
          visit(inline.content, inner);
          if (inline.target) markup(`](${inline.target})`, wrapper, inner);
          wrapper.end = text.length;
          break;
        }
        case "rev": {
          const isInsert = inline.kind === "ins" || inline.kind === "moveTo";
          const wrapper: Wrapper = { kind: isInsert ? "ins" : "del", el: inline.el, start: text.length, end: 0 };
          const inner = [...wrappers, wrapper];
          const rendered = renderInlines(inline.content);
          if (!rendered) {
            wrapper.end = text.length;
            break;
          }
          if (isInsert) {
            markup("{++", wrapper, inner);
            visit(inline.content, inner);
            markup("++}", wrapper, inner);
          } else {
            push({ kind: "frozen", wrappers: inner, owner: wrapper }, `{--${rendered}--}`);
          }
          wrapper.end = text.length;
          break;
        }
        case "sdt": {
          const wrapper: Wrapper = { kind: "sdt", el: inline.el, start: text.length, end: 0 };
          visit(inline.content, [...wrappers, wrapper]);
          wrapper.end = text.length;
          break;
        }
        case "comment":
          push({ kind: "token", wrappers, label: `{comment ${inline.id}}`, nodes: [inline.node], deletable: true }, `{comment ${inline.id}}`);
          break;
        case "object": {
          const s = renderInlines([inline]);
          const inRun = inline.el.parent?.name === "w:r";
          push(
            {
              kind: "token",
              wrappers,
              label: s,
              nodes: [inline.el],
              deletable: inRun,
              why: inRun ? undefined : `${s} sits outside a run and cannot be deleted as a tracked change`,
            },
            s,
          );
          break;
        }
      }
    }
  };

  visit(p.inlines, []);
  return { paragraph: p, text, slots, fields };
}

/** Run children inside a w:fldSimple (its displayed result). */
function fldSimpleNodes(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (e: XmlElement) => {
    for (const c of e.children) {
      if (c.kind !== "element") continue;
      if (c.name === "w:r") {
        for (const k of c.children) if (k.kind === "element" && k.name !== "w:rPr") out.push(k);
      } else walk(c);
    }
  };
  walk(el);
  return out;
}
