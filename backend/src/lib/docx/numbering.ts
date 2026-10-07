// List numbering: compute the label Word displays for a numbered paragraph
// ("12.3(b)") from numbering.xml and styles.xml.
//
// Labels are computed by walking paragraphs in document order through
// `NumberingTracker.next`, which keeps the counters Word keeps:
//   - num instances share their abstract definition's counters, so they
//     continue each other's numbering;
//   - an instance's lvlOverride/startOverride restarts a level the first time
//     that instance is used at that level or a shallower one;
//   - a level restarts when a shallower level is used (or per w:lvlRestart);
//   - w:isLgl renders every level in the label as a decimal.
// Correctness is measured against Word's own rendering by the REF-field
// oracle test, not assumed.

import { childElements, documentElement, firstChild, type XmlElement, type XmlSource } from "./xmlSource";
import { parseIntOr, readNumPr, type NumberingRef, type StyleSheet } from "./styles";

interface LevelDef {
  start: number;
  numFmt: string;
  lvlText: string;
  /** undefined = restart after any shallower level; 0 = never restart; n = restart after level n-1. */
  restart?: number;
  isLgl: boolean;
  pStyle?: string;
}

interface AbstractDef {
  levels: Map<number, LevelDef>;
  /** w:numStyleLink: this definition is a reference to a numbering style. */
  numStyleLink?: string;
  /** w:styleLink: this definition defines a numbering style. */
  styleLink?: string;
}

interface NumDef {
  abstractId: string;
  overrides: Map<number, { startOverride?: number; level?: LevelDef }>;
}

export interface NumberingLabel {
  /** The label as Word displays it at this paragraph, e.g. "(b)" or "•". */
  label: string;
  /** The label in full context, e.g. "12.3(b)": how cross-references and lawyers address it. */
  fullLabel: string;
  numId: string;
  level: number;
  isBullet: boolean;
}

export class NumberingDefinitions {
  readonly abstracts = new Map<string, AbstractDef>();
  readonly nums = new Map<string, NumDef>();

  constructor(xml: XmlSource | undefined) {
    if (!xml) return;
    const root = documentElement(xml);
    for (const abs of childElements(root, "w:abstractNum")) {
      const id = abs.attrs["w:abstractNumId"];
      if (id === undefined) continue;
      const levels = new Map<number, LevelDef>();
      for (const lvl of childElements(abs, "w:lvl")) {
        const def = readLevel(lvl);
        if (def) levels.set(parseIntOr(lvl.attrs["w:ilvl"], 0)!, def);
      }
      this.abstracts.set(id, {
        levels,
        numStyleLink: firstChild(abs, "w:numStyleLink")?.attrs["w:val"],
        styleLink: firstChild(abs, "w:styleLink")?.attrs["w:val"],
      });
    }
    for (const num of childElements(root, "w:num")) {
      const id = num.attrs["w:numId"];
      const absId = firstChild(num, "w:abstractNumId")?.attrs["w:val"];
      if (id === undefined || absId === undefined) continue;
      const overrides: NumDef["overrides"] = new Map();
      for (const ov of childElements(num, "w:lvlOverride")) {
        const ilvl = parseIntOr(ov.attrs["w:ilvl"], 0)!;
        const so = firstChild(ov, "w:startOverride")?.attrs["w:val"];
        const lvl = firstChild(ov, "w:lvl");
        overrides.set(ilvl, {
          startOverride: so !== undefined ? parseIntOr(so) : undefined,
          level: lvl ? readLevel(lvl) : undefined,
        });
      }
      this.nums.set(id, { abstractId: absId, overrides });
    }
  }

  /**
   * Resolve numStyleLink indirection: an abstractNum that only links to a
   * numbering style takes its levels from the abstractNum that defines that
   * style (found through the style's own numPr).
   */
  resolveAbstract(absId: string, styles: StyleSheet): { id: string; def: AbstractDef } | undefined {
    let id = absId;
    for (let guard = 0; guard < 5; guard++) {
      const def = this.abstracts.get(id);
      if (!def) return undefined;
      if (!def.numStyleLink) return { id, def };
      const linkedNumId = styles.styles.get(def.numStyleLink)?.numPr?.numId;
      const target = linkedNumId ? this.nums.get(linkedNumId)?.abstractId : undefined;
      if (!target || target === id) return { id, def };
      id = target;
    }
    return undefined;
  }
}

function readLevel(lvl: XmlElement): LevelDef | undefined {
  const start = parseIntOr(firstChild(lvl, "w:start")?.attrs["w:val"], 1)!;
  const numFmt = firstChild(lvl, "w:numFmt")?.attrs["w:val"] ?? "decimal";
  const lvlText = firstChild(lvl, "w:lvlText")?.attrs["w:val"] ?? "";
  const restartEl = firstChild(lvl, "w:lvlRestart");
  const isLglEl = firstChild(lvl, "w:isLgl");
  return {
    start,
    numFmt,
    lvlText,
    restart: restartEl ? parseIntOr(restartEl.attrs["w:val"]) : undefined,
    isLgl: !!isLglEl && isLglEl.attrs["w:val"] !== "0" && isLglEl.attrs["w:val"] !== "false",
    pStyle: firstChild(lvl, "w:pStyle")?.attrs["w:val"],
  };
}

/** Walks paragraphs in document order and produces Word's list labels. */
export class NumberingTracker {
  private readonly counters = new Map<string, (number | undefined)[]>();
  private readonly appliedOverrides = new Map<string, Set<number>>();

  constructor(
    private readonly defs: NumberingDefinitions,
    private readonly styles: StyleSheet,
  ) {}

  /**
   * Effective numbering for a paragraph: direct numPr wins field by field over
   * the style chain. numId "0" means explicitly not numbered.
   */
  effectiveNumPr(direct: NumberingRef | undefined, styleId: string | undefined): NumberingRef | undefined {
    const inherited = this.styles.inheritedNumPr(styleId);
    const numId = direct?.numId ?? inherited?.numId;
    if (numId === undefined || numId === "0") return undefined;
    let ilvl = direct?.ilvl ?? (direct?.numId === undefined ? inherited?.ilvl : undefined);
    if (ilvl === undefined) {
      // A style-linked level: the level whose pStyle is this paragraph's style.
      ilvl = this.levelForStyle(numId, styleId) ?? 0;
    }
    return { numId, ilvl };
  }

  private levelForStyle(numId: string, styleId: string | undefined): number | undefined {
    if (!styleId) return undefined;
    const num = this.defs.nums.get(numId);
    if (!num) return undefined;
    const abs = this.defs.resolveAbstract(num.abstractId, this.styles);
    if (!abs) return undefined;
    for (const [ilvl, lvl] of abs.def.levels) if (lvl.pStyle === styleId) return ilvl;
    return undefined;
  }

  /** Advance counters for one numbered paragraph and return its label. */
  next(ref: NumberingRef): NumberingLabel | undefined {
    const numId = ref.numId!;
    const ilvl = Math.max(0, Math.min(8, ref.ilvl ?? 0));
    const num = this.defs.nums.get(numId);
    if (!num) return undefined;
    const abs = this.defs.resolveAbstract(num.abstractId, this.styles);
    if (!abs) return undefined;

    const levelDef = (i: number): LevelDef | undefined =>
      num.overrides.get(i)?.level ?? abs.def.levels.get(i);
    const startOf = (i: number): number =>
      num.overrides.get(i)?.startOverride ?? levelDef(i)?.start ?? 1;

    // Counters belong to the abstract definition, so num instances sharing
    // it continue each other's numbering. An instance's overrides restart a
    // level the first time that instance is used at that level or a
    // shallower one; overrides of levels shallower than the one in use wait.
    // Both halves are measured against Word's cached REF results: MSC
    // Schedules restart each schedule's clause 1 through a sibling instance
    // used at level 0, while the ICO Addendum's sibling instance, first used
    // at level 3, leaves its parent clause count (12 -> 13) alone.
    let counters = this.counters.get(abs.id);
    if (!counters) {
      counters = new Array(9).fill(undefined);
      this.counters.set(abs.id, counters);
    }
    let applied = this.appliedOverrides.get(numId);
    if (!applied) {
      applied = new Set();
      this.appliedOverrides.set(numId, applied);
    }
    for (const [i, ov] of num.overrides) {
      if (i < ilvl || applied.has(i)) continue;
      applied.add(i);
      if (ov.startOverride !== undefined) counters[i] = ov.startOverride - 1;
      else if (ov.level !== undefined) counters[i] = undefined;
    }

    const current = counters[ilvl];
    counters[ilvl] = current === undefined ? startOf(ilvl) : current + 1;

    // Shallower levels referenced by this label but never shown take their
    // start value, and keep it: the next item at that level continues from it.
    for (let k = 0; k < ilvl; k++) {
      if (counters[k] === undefined) counters[k] = startOf(k);
    }

    // Deeper levels restart per their lvlRestart rule.
    for (let d = ilvl + 1; d < 9; d++) {
      const restart = levelDef(d)?.restart;
      if (restart === 0) continue;
      // Default: restart after any shallower level. lvlRestart=n: restart
      // only when a level shallower than n (i.e. index < n) is used.
      if (restart === undefined || ilvl < restart) counters[d] = undefined;
    }

    const render = (lvl: number): { text: string; minRef: number } => {
      const def = levelDef(lvl);
      if (!def) return { text: "", minRef: lvl };
      let minRef = lvl;
      const text = def.lvlText.replace(/%([1-9])/g, (_m, digit: string) => {
        const k = parseInt(digit, 10) - 1;
        if (k < minRef) minRef = k;
        const value = counters![k] ?? startOf(k);
        return formatNumber(value, def.isLgl ? "decimal" : levelDef(k)?.numFmt ?? "decimal");
      });
      return { text, minRef };
    };

    const def = levelDef(ilvl);
    if (!def) return { label: "", fullLabel: "", numId, level: ilvl, isBullet: false };
    const isBullet = def.numFmt === "bullet";
    if (isBullet) return { label: def.lvlText, fullLabel: def.lvlText, numId, level: ilvl, isBullet };
    const own = render(ilvl);
    // Full context: prepend the label of the level just above the shallowest
    // level this label already shows, until level 0 is covered.
    let full = own.text;
    let covered = own.minRef;
    while (covered > 0) {
      const parent = render(covered - 1);
      full = parent.text.replace(/[.\s]+$/, "") + full;
      covered = Math.min(parent.minRef, covered - 1);
    }
    return { label: own.text, fullLabel: full, numId, level: ilvl, isBullet };
  }
}

export function formatNumber(n: number, fmt: string): string {
  switch (fmt) {
    case "decimal":
      return String(n);
    case "decimalZero":
      return n < 10 ? `0${n}` : String(n);
    case "upperRoman":
      return toRoman(n);
    case "lowerRoman":
      return toRoman(n).toLowerCase();
    case "upperLetter":
      return toLetters(n);
    case "lowerLetter":
      return toLetters(n).toLowerCase();
    case "ordinal":
      return `${n}${ordinalSuffix(n)}`;
    case "none":
      return "";
    case "bullet":
      return "";
    default:
      return String(n);
  }
}

function toRoman(n: number): string {
  if (n <= 0) return String(n);
  const table: [number, string][] = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
    [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let out = "";
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}

/** Word's letter numbering repeats the letter: 1=A, 26=Z, 27=AA, 28=BB. */
function toLetters(n: number): string {
  if (n <= 0) return String(n);
  const letter = String.fromCharCode(65 + ((n - 1) % 26));
  return letter.repeat(Math.floor((n - 1) / 26) + 1);
}

function ordinalSuffix(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

export { readNumPr };
