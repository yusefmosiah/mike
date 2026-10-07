import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";
import { DOCX_CORPUS_DIR, readCorpusFile } from "../../../__tests__/helpers/docxCorpus";
import { canonicalDocx } from "../../../__tests__/helpers/trackedChangesOracle";
import { resolveRevisions } from "../revisions";

const RP_DIR = path.join(DOCX_CORPUS_DIR, "powertools/rp");

/** Every reference result: [base file, mode, reference file]. */
const PAIRS = readdirSync(RP_DIR)
  .map((name) => name.match(/^(.*)-(Accepted|Rejected)\.docx$/))
  .filter((m): m is RegExpMatchArray => m !== null)
  .map((m) => ({
    base: `powertools/rp/${m[1]}.docx`,
    mode: m[2] === "Accepted" ? ("accept" as const) : ("reject" as const),
    reference: `powertools/rp/${m[0]}`,
  }));

/**
 * References our engine deliberately disagrees with, fixed before the run.
 * Each says why; anything not listed must match exactly.
 */
const KNOWN_DIFFERENCES: Record<string, string> = {
  "powertools/rp/RP001-Tracked-Revisions-01-Accepted.docx":
    "the reference leaves a table with no rows once its deleted rows are accepted; we remove the table (a table needs a row)",
  "powertools/rp/RP001-Tracked-Revisions-02-Accepted.docx": "same as RP001-01",
  "powertools/rp/RP015-MoveFrom-MoveTo-Accepted.docx":
    "the reference keeps an empty paragraph where the moved-from paragraph mark was; we treat a moved paragraph mark like a deleted one",
  "powertools/rp/RP015-MoveFrom-MoveTo-Rejected.docx":
    "same as RP015 accepted, for the moved-to paragraph mark",
  "powertools/rp/RP034-Deleted-Cells-Accepted.docx":
    "the reference widens the remaining cell (gridSpan) when deleted cells are accepted; we remove the cells only",
  "powertools/rp/RP051-Arabic-Rejected.docx":
    "the reference leaves two tables with no rows, and drops the style of an untouched paragraph after rejecting the inserted paragraphs before it",
};

describe("accept-all / reject-all against the RevisionProcessor references", () => {
  it("finds the reference pairs", () => {
    expect(PAIRS.length).toBeGreaterThan(100);
  });

  it.each(PAIRS)("$reference", async ({ base, mode, reference }) => {
    const ours = await canonicalDocx((await resolveRevisions(readCorpusFile(base), mode)).bytes);
    const theirs = await canonicalDocx(readCorpusFile(reference));
    if (KNOWN_DIFFERENCES[reference]) {
      expect(ours, "listed as a known difference; remove it from the list").not.toEqual(theirs);
    } else {
      expect(ours).toEqual(theirs);
    }
  });

  it("leaves a document without tracked changes byte-identical", async () => {
    const bytes = readCorpusFile("public-legal/uk-msc-core-terms-v2.2a.docx");
    for (const mode of ["accept", "reject"] as const) {
      const res = await resolveRevisions(bytes, mode);
      expect(res.found.size).toBe(0);
      expect(res.bytes.equals(bytes)).toBe(true);
    }
  });

  it("resolves only the selected revision ids", async () => {
    const bytes = readCorpusFile("powertools/rp/RP002-Deleted-Text.docx");
    const res = await resolveRevisions(bytes, "accept", ["does-not-exist"]);
    expect(res.found.size).toBe(0);
    expect(res.bytes.equals(bytes)).toBe(true);
  });
});
