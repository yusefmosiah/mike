import { describe, expect, it } from "vitest";
import { parseEditOps } from "../edit";

// What edit_document makes of the model's arguments, before any document is
// touched: aliases read as what they mean, mistakes refused with the fix.

describe("parseEditOps", () => {
  it("reads the canonical shapes", () => {
    expect(
      parseEditOps([
        { op: "replace", block: "p3", find: "30 days", replace: "45 days", reason: "Longer notice" },
        { op: "insert", after: "p3", paragraphs: ["New clause."] },
        { op: "delete", block: "p4", through: "p6" },
        { op: "format", block: "p7", bold: true },
        { op: "insert_row", before: "t1", cells: ["a", "b"] },
        { op: "delete_row", block: "p9" },
      ]),
    ).toEqual({
      ok: true,
      ops: [
        { op: "replace", block: "p3", find: "30 days", replace: "45 days", reason: "Longer notice" },
        { op: "insert", after: "p3", before: undefined, paragraphs: ["New clause."], style: undefined, reason: undefined },
        { op: "delete", block: "p4", through: "p6", reason: undefined },
        expect.objectContaining({ op: "format", block: "p7", bold: true }),
        { op: "insert_row", after: undefined, before: "t1", cells: ["a", "b"], reason: undefined },
        { op: "delete_row", block: "p9", through: undefined, reason: undefined },
      ],
    });
  });

  it("accepts type and action for op, and block_id and text aliases", () => {
    const parsed = parseEditOps([
      { type: "insert", after: "p3", text: "First.\n\nSecond." },
      { action: "Replace", block_id: "p4", find: "a", replace: "b" },
      { type: "remove", blockId: "p5" },
    ]);
    expect(parsed).toEqual({
      ok: true,
      ops: [
        expect.objectContaining({ op: "insert", after: "p3", paragraphs: ["First.", "Second."] }),
        expect.objectContaining({ op: "replace", block: "p4", find: "a", replace: "b" }),
        expect.objectContaining({ op: "delete", block: "p5" }),
      ],
    });
  });

  it("never reads an insert as a replace", () => {
    // The production failure: {"type": "insert"} was read as op "replace"
    // and failed with "find is required".
    const parsed = parseEditOps([{ type: "insert", after: "p3", paragraphs: ["x"] }]);
    expect(parsed.ok && parsed.ops[0].op).toBe("insert");
  });

  it("refuses an unknown op with a suggestion and the list of valid ops", () => {
    const parsed = parseEditOps([{ op: "insret", after: "p3", paragraphs: ["x"] }]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('edit 1 has unknown op "insret" (did you mean "insert"?)');
    expect(parsed.error).toContain("Valid ops and their fields: replace {block, find, replace}; insert {after or before, paragraphs");
  });

  it("refuses unknown keys with a suggestion", () => {
    const parsed = parseEditOps([{ op: "replace", block: "p3", find: "a", replacce: "b" }]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('edit 1 has unknown key "replacce" (did you mean "replace"?)');
  });

  it("names the missing fields of each op, and every bad edit at once", () => {
    const parsed = parseEditOps([
      { op: "insert", block: "p3", paragraphs: ["x"] },
      { op: "replace", block: "p4", find: "a" },
      { op: "format", block: "p5" },
      { op: "delete", block: "p6" },
    ]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/^No edits were applied: /);
    expect(parsed.error).toContain("edit 1 (insert) is missing after or before (insert names its anchor");
    expect(parsed.error).toContain("edit 2 (replace) is missing replace");
    expect(parsed.error).toContain("edit 3 (format) is missing one of bold");
    expect(parsed.error).not.toContain("edit 4");
  });

  it("infers the op from the fields when none is given", () => {
    const parsed = parseEditOps([
      { block: "p3", find: "a", replace: "b" },
      { after: "p3", paragraphs: ["x"] },
    ]);
    expect(parsed.ok && parsed.ops.map((op) => op.op)).toEqual(["replace", "insert"]);
    expect(parseEditOps([{ block: "p3" }])).toMatchObject({ ok: false, error: expect.stringContaining("edit 1 has no op") });
  });

  it("refuses an empty or missing list, and reads a JSON string", () => {
    expect(parseEditOps(undefined).ok).toBe(false);
    expect(parseEditOps([]).ok).toBe(false);
    expect(parseEditOps(JSON.stringify([{ op: "delete", block: "p1" }]))).toMatchObject({ ok: true });
  });
});
