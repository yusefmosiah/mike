// Clause labels measured against Word's own rendering. Word caches the
// rendered number of a REF field's target paragraph in the field result:
// `\w` is full context ("12.3(b)"), `\n` is the number as displayed ("(b)"),
// `\r` is relative to the field's position. See ./refOracle.ts.

import { describe, expect, it } from "vitest";
import { corpusFiles, readCorpusFile } from "../../../__tests__/helpers/docxCorpus";
import { DocxDocument } from "../view";
import { refCases, type RefCase } from "./refOracle";

const strip = (s?: string) => (s ?? "").replace(/[.\s]+$/, "");

function matches(c: RefCase): boolean {
  const full = strip(c.target?.fullLabel);
  const own = strip(c.target?.label);
  if (c.switch === "w") return c.expected === full;
  if (c.switch === "n") return c.expected === own;
  // \r depends on where the field sits; Word shows either the full label or
  // only the levels that differ from the field's own clause.
  return c.expected === full || c.expected === own;
}

/**
 * Every known mismatch, keyed "file|switch|expected|computed full label".
 * A new mismatch fails the test; a fixed one must be removed from here.
 */
const KNOWN_MISMATCHES = new Set([
  // Definition sub-lists: Word's \w omits the parent "(e)". Unexplained.
  "public-legal/uk-msc-consolidated-schedules-v2.2a.docx|w|(i)|(e)(i)",
  "public-legal/uk-msc-consolidated-schedules-v2.2a.docx|w|(vii)|(e)(vii)",
  // REF to an unnumbered paragraph: Word renders "0".
  "public-legal/uk-msc-consolidated-schedules-v2.2a.docx|r|0|",
  // Off by one on every schedule heading. The document has a hand-typed
  // "sCHEDULE 3" heading with numbering removed, which suggests the cached
  // field results predate a manual edit; not confirmable without Word.
  "public-legal/uk-academy-commercial-transfer-agreement-2013.docx|r|Schedule 2|Schedule 1",
  "public-legal/uk-academy-commercial-transfer-agreement-2013.docx|r|Schedule 3|Schedule 2",
  "public-legal/uk-academy-commercial-transfer-agreement-2013.docx|r|Schedule 4|Schedule 3",
]);

describe("clause labels against Word's cached REF results", () => {
  it("matches Word on every REF \\w, \\n and \\r field in the corpus except the listed ones", async () => {
    const totals: Record<string, { ok: number; total: number }> = {};
    const unexpected: string[] = [];
    const seenKnown = new Set<string>();
    for (const file of corpusFiles()) {
      const doc = await DocxDocument.load(readCorpusFile(file));
      for (const c of refCases(doc)) {
        const t = (totals[c.switch] ??= { ok: 0, total: 0 });
        t.total++;
        if (matches(c)) {
          t.ok++;
          continue;
        }
        const ws = (v: string) => v.replace(/\s+/g, " ");
        const key = `${file}|${c.switch}|${ws(c.expected)}|${ws(c.target?.fullLabel ?? "")}`;
        if (KNOWN_MISMATCHES.has(key)) seenKnown.add(key);
        else unexpected.push(`${key} (target ${c.target?.id ?? "missing"})`);
      }
    }
    expect(unexpected).toEqual([]);
    expect([...KNOWN_MISMATCHES].filter((k) => !seenKnown.has(k))).toEqual([]);
    // Coverage floor: the corpus must keep exercising the oracle.
    expect(totals.w.total).toBeGreaterThanOrEqual(693);
    expect(totals.n.total).toBeGreaterThanOrEqual(378);
    expect(totals.r.total).toBeGreaterThanOrEqual(526);
    console.info("REF oracle", JSON.stringify(totals));
  }, 120_000);
});
