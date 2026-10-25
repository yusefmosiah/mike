import { describe, expect, it } from "vitest";
import { cellSummary } from "../python";

describe("cellSummary", () => {
  it("keeps the model's own summary", () => {
    expect(cellSummary("x = 1", "  Read the lease and list its break clauses  ")).toEqual({
      text: "Read the lease and list its break clauses",
      source: "model",
    });
  });

  it("falls back to the cell's first comment", () => {
    const code = "#!/usr/bin/env python\n# -*- coding: utf-8 -*-\n# Compare the two indemnity caps\nimport re";
    expect(cellSummary(code, undefined)).toEqual({ text: "Compare the two indemnity caps", source: "extractive" });
  });

  it("ignores linter lines, punctuation-only comments and blank summaries", () => {
    expect(cellSummary("# noqa: E501\n# ----\nprint(1)", "   ")).toBeUndefined();
  });

  it("caps a long summary", () => {
    expect(cellSummary("", "a".repeat(5000))?.text).toHaveLength(1000);
  });
});
