import { describe, expect, it } from "vitest";

import { markdownTableToText, repairToolArguments } from "../toolCallParsing";

describe("repairToolArguments", () => {
  it("passes an already-parsed object through untouched", () => {
    const input = { query: "MIKE", limit: 10 };
    expect(repairToolArguments(input)).toEqual({ ok: true, input });
  });

  it("parses strict JSON", () => {
    expect(repairToolArguments('{"query":"MIKE"}')).toEqual({
      ok: true,
      input: { query: "MIKE" },
    });
  });

  it("parses JSON wrapped in a markdown fence", () => {
    expect(
      repairToolArguments('```json\n{"query":"MIKE","limit":5}\n```'),
    ).toEqual({ ok: true, input: { query: "MIKE", limit: 5 } });
  });

  it("extracts the object out of surrounding prose", () => {
    expect(
      repairToolArguments('Here are the arguments: {"query":"MIKE"} — done'),
    ).toEqual({ ok: true, input: { query: "MIKE" } });
  });

  it("repairs trailing commas through jsonrepair", () => {
    expect(repairToolArguments('{"query":"MIKE","limit":5,}')).toEqual({
      ok: true,
      input: { query: "MIKE", limit: 5 },
    });
  });

  it("repairs python-style quoting and the doubled map delimiter", () => {
    expect(repairToolArguments("{'query':'MIKE'}")).toEqual({
      ok: true,
      input: { query: "MIKE" },
    });
    expect(repairToolArguments('{""search"::{"query":"MIKE"}}')).toEqual({
      ok: true,
      input: { search: { query: "MIKE" } },
    });
  });

  it("never throws on generate_docx-style prose with unescaped quotes and a markdown table", () => {
    const raw =
      '{"filename":"memo.docx","content":"Draft "final" memo\n| Name | Filed |\n|---|---|\n| Acme | 2024-01-01 |"}';
    const attempt = () => repairToolArguments(raw);
    expect(attempt).not.toThrow();
    const result = attempt();
    if (result.ok) {
      // jsonrepair recovered the object: the content must still be there.
      expect(typeof result.input.content).toBe("string");
    } else {
      // Otherwise the failure must be actionable, never a bare throw.
      expect(result.error).toMatch(/repair/i);
    }
  });

  it("returns a failure (never throws) for garbage arguments", () => {
    const garbage: unknown[] = [
      "",
      "   ",
      "not json at all",
      "[]",
      "42",
      "null",
      "true",
      undefined,
      [1, 2],
    ];
    for (const raw of garbage) {
      const result = repairToolArguments(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("markdownTableToText", () => {
  it("converts GFM pipe rows to tab-separated lines", () => {
    expect(markdownTableToText("| Name | Filed |\n| Acme | 2024-01-01 |")).toBe(
      "Name\tFiled\nAcme\t2024-01-01",
    );
  });

  it("trims each cell", () => {
    expect(markdownTableToText("|  a   |   b |")).toBe("a\tb");
  });

  it("keeps escaped pipes inside a cell", () => {
    expect(markdownTableToText("| A \\| B | C |")).toBe("A | B\tC");
  });

  it("leaves prose that merely contains a pipe untouched", () => {
    expect(markdownTableToText("search A | B")).toBe("search A | B");
  });

  it("converts only the row lines inside surrounding prose", () => {
    expect(markdownTableToText("Intro\n| a | b |\nOutro")).toBe(
      "Intro\na\tb\nOutro",
    );
  });
});
