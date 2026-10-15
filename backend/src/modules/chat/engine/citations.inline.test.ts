import { describe, expect, it } from "vitest";
import {
  InlineCitationStream,
  MAX_CITE_TAG_CHARS,
  citeGroupToCitations,
  parseCiteTag,
} from "./citations.inline";

const known = (label: string) => label === "doc-3f9a1c2e" || label === "doc-b71d0c55";

/** Runs the stream over `deltas`, then ends the segment. */
function run(deltas: string[], stream = new InlineCitationStream(known)) {
  let text = "";
  const citations = [];
  for (const delta of deltas) {
    const out = stream.push(delta);
    text += out.text;
    citations.push(...out.citations);
  }
  const tail = stream.end();
  return { text: text + tail.text, citations: [...citations, ...tail.citations], stream };
}

/** Every way to cut `input` into two deltas, and into single characters. */
function splits(input: string): string[][] {
  const out: string[][] = [[input], [...input]];
  for (let i = 1; i < input.length; i += 1) out.push([input.slice(0, i), input.slice(i)]);
  return out;
}

function expectSameAtEverySplit(input: string) {
  const whole = run([input]);
  for (const deltas of splits(input)) {
    const split = run(deltas);
    expect(split.text).toBe(whole.text);
    expect(split.citations).toEqual(whole.citations);
  }
  return whole;
}

describe("parseCiteTag", () => {
  it("reads attributes in any order and the verbatim quote", () => {
    expect(parseCiteTag('<cite page="3" doc="doc-1">  ninety (90) days &amp; more </cite>')).toEqual({
      tag: { attrs: { page: "3", doc: "doc-1" }, quote: "ninety (90) days &amp; more" },
    });
  });

  it("allows > inside an attribute value", () => {
    const parsed = parseCiteTag('<cite sheet="A>B" doc="d">x</cite>');
    expect(parsed).toMatchObject({ tag: { attrs: { sheet: "A>B" } } });
  });

  it.each([
    ['<cite doc="d"></cite>', "empty quote"],
    ['<cite doc="d">   </cite>', "empty quote"],
    ["<cite doc=d>x</cite>", "unparseable attributes"],
    ['<cite doc="d" doc="e">x</cite>', "duplicate attribute doc"],
    ['<cite doc="d"/>x</cite>', "unparseable attributes"],
  ])("rejects %s", (raw, error) => {
    expect(parseCiteTag(raw)).toEqual({ error });
  });
});

describe("citeGroupToCitations", () => {
  const tag = (attrs: Record<string, string>, quote = "q") => ({ attrs, quote });

  it("builds each source form", () => {
    const [doc, sheet, web, courtCase] = citeGroupToCitations(
      [
        tag({ doc: "doc-3f9a1c2e", page: "41-42" }, "a [[PAGE_BREAK]] b"),
        tag({ doc: "doc-b71d0c55", sheet: "Sheet1", cell: "B7:C9" }, "42"),
        tag({ url: "https://example.com/a" }, "page text"),
        tag({ case: "123", opinion: "456" }, "holding"),
      ],
      5,
      known,
    );
    expect(doc).toMatchObject({ kind: "document", ref: 5, doc_id: "doc-3f9a1c2e", page: "41-42" });
    expect(sheet).toMatchObject({ kind: "document", ref: 6, sheet: "Sheet1", cell: "B7:C9" });
    expect(web).toMatchObject({ kind: "web", ref: 7, url: "https://example.com/a" });
    expect(courtCase).toMatchObject({
      kind: "case",
      ref: 8,
      cluster_id: 123,
      quotes: [{ opinionId: 456, quote: "holding" }],
    });
  });

  it("defaults an unpaginated document to page 1", () => {
    const [citation] = citeGroupToCitations([tag({ doc: "doc-3f9a1c2e" })], 1, known);
    expect(citation).toMatchObject({ kind: "document", page: 1 });
  });

  it("joins tags for one source into one citation of up to three quotes", () => {
    const drops: string[] = [];
    const citations = citeGroupToCitations(
      [1, 2, 3, 4].map((n) => tag({ doc: "doc-3f9a1c2e", page: String(n) }, `q${n}`)),
      1,
      known,
      (reason) => drops.push(reason),
    );
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ kind: "document" });
    expect((citations[0] as { quotes: unknown[] }).quotes).toHaveLength(3);
    expect(drops).toEqual(["more than three quotes for one marker"]);
  });

  it("splits tags for different sources into separate citations", () => {
    const citations = citeGroupToCitations(
      [tag({ doc: "doc-3f9a1c2e" }), tag({ doc: "doc-b71d0c55" })],
      1,
      known,
    );
    expect(citations.map((c) => c.ref)).toEqual([1, 2]);
  });

  it.each([
    [{}, "no source attribute"],
    [{ doc: "doc-9999" }, "unknown document label"],
    [{ doc: "doc-3f9a1c2e", url: "https://example.com" }, "more than one source attribute"],
    [{ case: "abc" }, "invalid case id"],
    [{ case: "12", opinion: "x" }, "invalid opinion id"],
    [{ url: "javascript:alert(1)" }, "source could not be resolved"],
  ])("drops a tag with %j", (attrs, reason) => {
    const drops: string[] = [];
    expect(citeGroupToCitations([tag(attrs)], 1, known, (r) => drops.push(r))).toEqual([]);
    expect(drops).toEqual([reason]);
  });

  it("keeps the valid tags of a group with a bad one", () => {
    const citations = citeGroupToCitations([tag({ doc: "nope" }), tag({ doc: "doc-3f9a1c2e" })], 1, known);
    expect(citations).toHaveLength(1);
  });
});

describe("InlineCitationStream", () => {
  const tagA = '<cite doc="doc-3f9a1c2e" page="3">ninety days</cite>';
  const tagB = '<cite doc="doc-b71d0c55">other text</cite>';

  it("replaces a tag with its marker, keeping the whitespace before it", () => {
    const { text, citations } = expectSameAtEverySplit(`The period is 90 days ${tagA}. Next.`);
    expect(text).toBe("The period is 90 days [1]. Next.");
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ ref: 1, doc_id: "doc-3f9a1c2e", page: 3 });
  });

  it("re-emits the whitespace held after a tag, after the marker", () => {
    expect(expectSameAtEverySplit(`A ${tagA} \n B`).text).toBe("A [1] \n B");
    expect(expectSameAtEverySplit(`A ${tagA}  `).text).toBe("A [1]  ");
  });

  it("numbers markers 1..N in order of appearance", () => {
    const { text, citations } = expectSameAtEverySplit(`x ${tagA}. y ${tagB}. z ${tagA}.`);
    expect(text).toBe("x [1]. y [2]. z [3].");
    expect(citations.map((c) => c.ref)).toEqual([1, 2, 3]);
  });

  it("keeps numbering across segments", () => {
    const stream = new InlineCitationStream(known);
    const first = run([`a ${tagA}.`], stream);
    const second = run([`b ${tagB}.`], stream);
    expect(first.text).toBe("a [1].");
    expect(second.text).toBe("b [2].");
    expect(second.citations[0].ref).toBe(2);
  });

  it("joins adjacent tags for one source into one marker with their quotes", () => {
    const second = '<cite doc="doc-3f9a1c2e" page="5">more days</cite>';
    const { text, citations } = expectSameAtEverySplit(`x ${tagA}\n ${second}.`);
    expect(text).toBe("x [1].");
    expect(citations).toHaveLength(1);
    expect((citations[0] as { quotes: unknown[] }).quotes).toHaveLength(2);
  });

  it("makes adjacent tags for two sources two markers", () => {
    const { text, citations } = expectSameAtEverySplit(`x ${tagA} ${tagB}.`);
    expect(text).toBe("x [1][2].");
    expect(citations.map((c) => c.ref)).toEqual([1, 2]);
  });

  it("does not join tags separated by anything but whitespace", () => {
    const { text } = expectSameAtEverySplit(`x ${tagA}, ${tagB}.`);
    expect(text).toBe("x [1], [2].");
  });

  it("drops a malformed tag with no marker and no leaked tag text", () => {
    for (const bad of [
      '<cite page="3">no source</cite>',
      '<cite doc="doc-0000">unknown label</cite>',
      '<cite doc="doc-3f9a1c2e"></cite>',
      "<cite doc=unquoted>x</cite>",
    ]) {
      const { text, citations, stream } = expectSameAtEverySplit(`Claim ${bad}. Done.`);
      expect(text).toBe("Claim . Done.");
      expect(citations).toEqual([]);
      expect(stream.dropped).toHaveLength(1);
    }
  });

  it("keeps numbering contiguous when a tag is dropped", () => {
    const { text } = expectSameAtEverySplit(`a <cite>bad</cite>. b ${tagA}.`);
    expect(text).toBe("a . b [1].");
  });

  it("drops a tag still open when the text ends, leaking nothing", () => {
    const { text, citations, stream } = run(['Claim <cite doc="doc-3f9a1c2e" page="3">half a quo']);
    expect(text).toBe("Claim ");
    expect(citations).toEqual([]);
    expect(stream.dropped).toEqual(["tag still open when the text ended"]);
  });

  it("drops a tag open past the limit and resumes after its closing tag", () => {
    const long = "x".repeat(MAX_CITE_TAG_CHARS + 50);
    const input = `A <cite doc="doc-3f9a1c2e">${long}</cite> B ${tagA}.`;
    const { text, citations, stream } = expectSameAtEverySplit(input);
    expect(text).toBe("A  B [1].");
    expect(citations).toHaveLength(1);
    expect(stream.dropped).toEqual(["tag open past the length limit"]);
  });

  it("stops discarding an oversized, never-closed tag at the paragraph end", () => {
    const input = `A <cite doc="doc-3f9a1c2e">${"x".repeat(MAX_CITE_TAG_CHARS + 50)}\n\nNext paragraph.`;
    expect(expectSameAtEverySplit(input).text).toBe("A \n\nNext paragraph.");
  });

  it("releases prefixes that turn out not to be tags", () => {
    for (const text of ["a < b", "<c", "<ci", "<cit", "<cite", "<citeX>", "<cites doc=\"d\">x</cites>", "x <", "1 < 2 <3"]) {
      expect(expectSameAtEverySplit(text).text).toBe(text);
    }
  });

  it("leaves a bare [n] alone until a marker has been issued", () => {
    const input = "Per the lease [1], and again [12][3]. Also [Page 3] and [^1] and [a].";
    const { text, citations } = expectSameAtEverySplit(input);
    expect(text).toBe(input);
    expect(citations).toEqual([]);
  });

  it("leaves an already escaped marker and a partial one alone", () => {
    expect(expectSameAtEverySplit(String.raw`see \[1\] now`).text).toBe(String.raw`see \[1\] now`);
    expect(expectSameAtEverySplit("end [12").text).toBe("end [12");
    expect(expectSameAtEverySplit("end [").text).toBe("end [");
  });

  it("does not escape the markers it issues", () => {
    expect(expectSameAtEverySplit(`${tagA} and [2]`).text).toBe(String.raw`[1] and \[2\]`);
  });

  it("shows cite tags and [n] in a fenced code block as written", () => {
    const input = `Before\n\`\`\`xml\n${tagA} [1]\n\`\`\`\nAfter ${tagB}.`;
    const { text, citations } = expectSameAtEverySplit(input);
    expect(text).toBe(`Before\n\`\`\`xml\n${tagA} [1]\n\`\`\`\nAfter [1].`);
    expect(citations).toHaveLength(1);
  });

  it("shows cite tags and [n] in a code span as written", () => {
    const input = `Write \`${tagA} [1]\` like so, then ${tagB} and [2].`;
    const { text } = expectSameAtEverySplit(input);
    expect(text).toBe(`Write \`${tagA} [1]\` like so, then [1] and \\[2\\].`);
  });

  it("matches a double-backtick span by its length", () => {
    const input = `${tagA} \`\`a \` <cite doc="doc-3f9a1c2e">x</cite>\`\` then [1]`;
    expect(expectSameAtEverySplit(input).text).toBe(
      "[1] ``a ` <cite doc=\"doc-3f9a1c2e\">x</cite>`` then \\[1\\]",
    );
  });

  it("ends a stray backtick's span at the paragraph break", () => {
    const { text, citations } = expectSameAtEverySplit(`it\`s odd\n\nNext ${tagA}.`);
    expect(text).toBe("it`s odd\n\nNext [1].");
    expect(citations).toHaveLength(1);
  });

  it("treats a same-line triple-backtick span as a span, not a fence", () => {
    const { text } = expectSameAtEverySplit(`\`\`\`code\`\`\` then ${tagA}.`);
    expect(text).toBe("```code``` then [1].");
  });

  it("forgets code state between segments", () => {
    const stream = new InlineCitationStream(known);
    run(["```\nunclosed"], stream);
    expect(run([`next ${tagA}.`], stream).text).toBe("next [2].".replace("2", "1"));
  });

  it("never lets a doc label reach the text from a tag", () => {
    const { text } = expectSameAtEverySplit(`a ${tagA} b ${tagB} <cite doc="doc-0000">x</cite> <cite>y</cite>`);
    expect(text).not.toMatch(/doc-/);
  });

  it("produces the same output however a long answer is cut", () => {
    const input = [
      "## Summary",
      `The term is 90 days ${tagA} and fees are due ${tagB}`,
      `${tagA}.`,
      "A `<cite doc=\"x\">literal</cite>` span, a [1] slip and <not a tag>.",
      "```",
      `${tagA} [2]`,
      "```",
      `Last ${tagB}`,
    ].join("\n");
    expectSameAtEverySplit(input);
  });
});
