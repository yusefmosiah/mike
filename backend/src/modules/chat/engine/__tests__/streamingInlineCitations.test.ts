import { beforeEach, describe, expect, it, vi } from "vitest";

// Inline <cite> tags end to end through runLLMStream: the stream shows [n]
// where the model wrote a tag, the client gets each citation before its
// marker, and the final event carries the verified citations. The tag parser
// has its own suite (citations.inline.test.ts); this one pins the wiring in
// streaming.ts: segments, the legacy block, and the surfaces that opt out.

const LEASE = "Either party may end this lease on ninety (90) days' written notice.";
const MEMO = "The landlord disputes the notice period entirely.";

const { streamChatWithTools } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({ fullText: "" })),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: StreamChatCall) => streamChatWithTools(params),
}));
vi.mock("../../../../lib/mcpConnectors", () => ({
  buildUserMcpTools: vi.fn(async () => []),
}));

import { runLLMStream } from "../streaming";

type StreamChatCall = {
  callbacks: { onContentDelta: (d: string) => void; onToolCallStart: (c: { name: string }) => void };
  [key: string]: unknown;
};
type Frame = { type: string; text?: string; status?: string; citations?: Record<string, unknown>[] };

const docIndex = {
  "doc-aaaa1111": { document_id: "aaaa1111-0000-4000-8000-000000000000", filename: "Lease.md", version_id: "v-lease", version_number: 1 },
  "doc-bbbb2222": { document_id: "bbbb2222-0000-4000-8000-000000000000", filename: "Memo.md", version_id: "v-memo", version_number: 1 },
};
const docStore = () =>
  new Map<string, Record<string, unknown>>([
    ["doc-aaaa1111", { filename: "Lease.md", file_type: "md", storage_path: "", inline_text: LEASE }],
    ["doc-bbbb2222", { filename: "Memo.md", file_type: "md", storage_path: "", inline_text: MEMO }],
  ]);

const NOTICE = `<cite doc="doc-aaaa1111">ninety (90) days' written notice</cite>`;

/** `segments` are runs of deltas separated by a tool call. */
async function turn(segments: string[][], extra: Record<string, unknown> = {}) {
  const write = vi.fn();
  streamChatWithTools.mockImplementationOnce(async (params: StreamChatCall) => {
    for (const [i, deltas] of segments.entries()) {
      if (i > 0) params.callbacks.onToolCallStart({ name: "read_document" });
      for (const delta of deltas) params.callbacks.onContentDelta(delta);
    }
    return { fullText: "" };
  });
  const result = await runLLMStream({
    model: "gemini-3-flash-preview",
    apiMessages: [{ role: "user", content: "review" }],
    docStore: docStore(),
    docIndex,
    userId: "u1",
    db: {} as never,
    write,
    ...extra,
  } as never);
  const frames = write.mock.calls
    .map(([chunk]) => String(chunk))
    .filter((chunk) => chunk.startsWith("data: {"))
    .map((chunk) => JSON.parse(chunk.slice(6)) as Frame);
  const shown = frames.filter((f) => f.type === "content_delta").map((f) => f.text).join("");
  const stored = result.events.filter((e) => e.type === "content").map((e) => (e as { text: string }).text).join("");
  const final = frames.find((f) => f.type === "citations" && f.status === "final");
  return { result, frames, shown, stored, final };
}

const chars = (text: string) => [...text];

describe("inline citations in the stream", () => {
  beforeEach(() => streamChatWithTools.mockClear());

  it("shows a marker for each tag, with the same output at any delta split", async () => {
    const answer = `Notice is 90 days ${NOTICE}. The memo disagrees <cite doc="doc-bbbb2222">disputes the notice period</cite>.`;
    const whole = await turn([[answer]]);
    expect(whole.shown).toBe("Notice is 90 days [1]. The memo disagrees [2].");
    for (let i = 1; i < answer.length; i += 1) {
      const split = await turn([[answer.slice(0, i), answer.slice(i)]]);
      expect(split.shown).toBe(whole.shown);
      expect(split.stored).toBe(whole.stored);
    }
    const byChar = await turn([chars(answer)]);
    expect(byChar.shown).toBe(whole.shown);
    expect(byChar.stored).toBe(whole.shown);
    expect(byChar.shown).not.toMatch(/doc-|cite/);
  });

  it("sends each citation before its marker, and the verified set at the end", async () => {
    const { frames, final, result } = await turn([[`A ${NOTICE}. B <cite doc="doc-bbbb2222">landlord disputes</cite>.`]]);
    // A citation is on the wire before the content delta that holds its marker.
    const indexOf = (match: (f: Frame) => boolean) => frames.findIndex(match);
    for (const ref of [1, 2]) {
      const known = indexOf((f) => f.status === "partial" && !!f.citations?.some((c) => c.ref === ref));
      const shown = indexOf((f) => f.type === "content_delta" && !!f.text?.includes(`[${ref}]`));
      expect(known).toBeGreaterThanOrEqual(0);
      expect(known).toBeLessThan(shown);
    }
    expect(frames.filter((f) => f.type === "citations").at(-1)?.status).toBe("final");
    const partials = frames.filter((f) => f.status === "partial");
    expect(partials[0].citations?.map((c) => c.ref)).toEqual([1]);
    expect(partials[1].citations?.map((c) => c.ref)).toEqual([1, 2]);
    expect(final?.citations).toEqual(result.citations);
    expect(final?.citations?.map((c) => [c.ref, c.doc_id, c.verified])).toEqual([
      [1, "doc-aaaa1111", true],
      [2, "doc-bbbb2222", true],
    ]);
    expect(final?.citations?.[0]).toMatchObject({ document_id: docIndex["doc-aaaa1111"].document_id, version_id: "v-lease" });
  });

  it("numbers markers across text segments between tool calls", async () => {
    const { shown, stored, final } = await turn([
      [`First ${NOTICE}.`],
      [`Second <cite doc="doc-bbbb2222">disputes the notice period</cite>.`],
      [`Third ${NOTICE}.`],
    ]);
    expect(shown).toBe("First [1].Second [2].Third [3].");
    expect(stored).toBe(shown);
    expect(final?.citations?.map((c) => c.ref)).toEqual([1, 2, 3]);
  });

  it("makes one marker of adjacent tags for one source and two of different sources", async () => {
    const same = await turn([[`A ${NOTICE} <cite doc="doc-aaaa1111">either party may end</cite>.`]]);
    expect(same.shown).toBe("A [1].");
    expect(same.final?.citations).toHaveLength(1);
    expect((same.final?.citations?.[0].quotes as unknown[]).length).toBe(2);

    const two = await turn([[`A ${NOTICE} <cite doc="doc-bbbb2222">disputes the notice period</cite>.`]]);
    expect(two.shown).toBe("A [1][2].");
    expect(two.final?.citations).toHaveLength(2);
  });

  it("drops malformed and unclosed tags without a marker or leaked text", async () => {
    const { shown, final } = await turn([
      [`A <cite page="3">no source</cite>. B <cite doc="doc-zzzz">x</cite>. C <cite doc="doc-aaaa1111">never clo`],
    ]);
    expect(shown).toBe("A . B . C ");
    expect(final?.citations).toEqual([]);
  });

  it("leaves a bare [n] alone in a turn without tags, for the legacy block", async () => {
    const { shown, stored, final } = await turn([["The lease says so [1] and [2]."]]);
    expect(shown).toBe("The lease says so [1] and [2].");
    expect(stored).toBe(shown);
    expect(final?.citations).toEqual([]);
  });

  it("shows <cite in code as written", async () => {
    const code = "```\n" + NOTICE + " [1]\n```";
    const { shown, final } = await turn([[`Use \`${NOTICE}\` like this:\n${code}`]]);
    expect(shown).toBe(`Use \`${NOTICE}\` like this:\n${code}`);
    expect(final?.citations).toEqual([]);
  });

  it("re-attributes a quote to the document that holds it", async () => {
    const { final } = await turn([[`Disputed <cite doc="doc-aaaa1111">landlord disputes the notice period</cite>.`]]);
    expect(final?.citations?.[0]).toMatchObject({
      ref: 1,
      doc_id: "doc-bbbb2222",
      document_id: docIndex["doc-bbbb2222"].document_id,
      version_id: "v-memo",
      verified: true,
    });
  });

  it("still parses a legacy block when the turn has no tags", async () => {
    const block = `<CITATIONS>[{"ref": 1, "doc_id": "doc-aaaa1111", "quotes": [{"page": 1, "quote": "ninety (90) days' written notice"}]}]</CITATIONS>`;
    const { shown, final } = await turn([["Notice is 90 days [1].\n", block]]);
    // The prose marker stays a marker, so the block's citation is clickable.
    expect(shown).toBe("Notice is 90 days [1].\n");
    expect(final?.citations?.map((c) => [c.ref, c.doc_id, c.verified])).toEqual([[1, "doc-aaaa1111", true]]);
  });

  it("ignores a trailing block when the turn has tags", async () => {
    const block = `<CITATIONS>[{"ref": 1, "doc_id": "doc-bbbb2222", "quotes": [{"page": 1, "quote": "landlord disputes"}]}]</CITATIONS>`;
    const { shown, final, frames } = await turn([[`Notice ${NOTICE}.\n${block}`]]);
    expect(shown).toBe("Notice [1].\n");
    expect(final?.citations?.map((c) => [c.ref, c.doc_id])).toEqual([[1, "doc-aaaa1111"]]);
    expect(frames.some((f) => f.status === "started")).toBe(false);
  });

  it("does no inline processing when the surface builds its own citations", async () => {
    const text = `Cited [1] ${NOTICE}.`;
    const built = vi.fn(() => [{ ref: 1 }]);
    const { shown, final } = await turn([[text]], { buildCitations: built });
    expect(shown).toBe(text);
    expect(built).toHaveBeenCalledWith(text);
    expect(final?.citations).toEqual([{ ref: 1 }]);
  });
});
