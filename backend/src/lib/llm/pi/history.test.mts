import { describe, expect, it } from "vitest";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { historyItems, readHistory, searchHistory } from "./history.mjs";

const at = Date.UTC(2026, 9, 21, 9, 0);
const entry = (id: number, model: unknown[]): EntryRecord =>
  ({ id, conversationId: 1, kind: "pi.entry", model }) as unknown as EntryRecord;
const user = (text: string, minute = 0) => ({ role: "user", content: text, timestamp: at + minute * 60_000 });
const assistant = (text: string, calls: { name: string; arguments: object }[] = []) => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking: "private" },
    ...(text ? [{ type: "text", text }] : []),
    ...calls.map((call, index) => ({ type: "toolCall", id: `c${index}`, ...call })),
  ],
  timestamp: at,
});
const result = (toolName: string, text: string) => ({
  role: "toolResult",
  toolCallId: "c0",
  toolName,
  content: [{ type: "text", text }],
  isError: false,
  timestamp: at,
});

const entries = [
  entry(1, [user("<thread-memory>\nmemory\n</thread-memory>\n\n[Sent: Tue 09:00]\nThe escrow agent is Halvorsen & Pike LLP.")]),
  entry(2, [assistant("Noted.", [{ name: "read_document", arguments: { doc_id: "doc-1" } }])]),
  entry(3, [result("read_document", `Clause 9: ${"filler ".repeat(2_000)}The cap is EUR 4.2 million.`)]),
  entry(4, [user("<harness>\nContinue.\n</harness>")]),
  entry(5, [user("The conversation history before this point was compacted into the following summary:\n\n<summary>\nx\n</summary>")]),
  entry(6, [user("What is the cap again?", 5)]),
];
// The current context starts at the summary.
const items = historyItems(entries, new Set([5, 6]));
const parse = (reply: { content: string }) => JSON.parse(reply.content);

describe("the conversation's history", () => {
  it("names each message by its entry, without the summary, Mike's notes or the blocks before the person's words", () => {
    expect(items.map((item) => [item.id, item.role, item.compacted])).toEqual([
      ["m1", "user", true],
      ["m2", "assistant", true],
      ["m3", "tool", true],
      ["m6", "user", false],
    ]);
    expect(items[0]!.text).toBe("The escrow agent is Halvorsen & Pike LLP.");
    expect(items[1]!.text).toBe('Noted.\n[called read_document {"doc_id":"doc-1"}]');
    expect(items[2]!.text.startsWith("[result of read_document]\nClause 9:")).toBe(true);
  });

  it("finds the newest matches first, with a snippet around the hit, by words or by pattern", () => {
    const words = parse(searchHistory(items, { query: "escrow   agent" }));
    expect(words.total).toBe(1);
    expect(words.matches[0]).toMatchObject({ id: "m1", role: "user", at: "2026-10-21 09:00", compacted: true, hits: 1 });
    expect(words.matches[0].snippet).toBe("The escrow agent is Halvorsen & Pike LLP.");

    const cap = parse(searchHistory(items, { query: String.raw`EUR\s+[\d.]+\s+million`, regex: true, context_chars: 10 }));
    expect(cap.matches[0]).toMatchObject({ id: "m3", role: "tool" });
    expect(cap.matches[0].snippet).toBe("…he cap is EUR 4.2 million.");

    expect(parse(searchHistory(items, { query: "cap", roles: ["user"] })).matches.map((m: { id: string }) => m.id)).toEqual(["m6"]);
    expect(parse(searchHistory(items, { query: "cap", compacted_only: true })).matches.map((m: { id: string }) => m.id)).toEqual(["m3"]);
  });

  it("pages a long search with `before`", () => {
    const many = historyItems(Array.from({ length: 5 }, (_, i) => entry(i + 1, [user(`note ${i + 1}`)])), new Set());
    const first = parse(searchHistory(many, { query: "note", limit: 2 }));
    expect(first.matches.map((m: { id: string }) => m.id)).toEqual(["m5", "m4"]);
    expect(first.total).toBe(5);
    expect(first.more).toContain('before="m4"');
    const second = parse(searchHistory(many, { query: "note", limit: 2, before: "m4" }));
    expect(second.matches.map((m: { id: string }) => m.id)).toEqual(["m3", "m2"]);
  });

  it("refuses an empty query or a broken pattern in words the model can act on", () => {
    expect(searchHistory(items, {})).toEqual({ content: "Give a query: words or a pattern to find.", isError: true });
    expect(searchHistory(items, { query: "(", regex: true }).isError).toBe(true);
  });

  it("reads a message in pages, or a run of messages in order", () => {
    const page = parse(readHistory(items, { id: "m3", limit_chars: 100 }));
    expect(page).toMatchObject({ id: "m3", offset: 0, compacted: true });
    expect(page.text).toHaveLength(100);
    expect(page.more).toBe('continue with history_read(id="m3", offset=100)');
    const rest = parse(readHistory(items, { id: "m3", offset: page.length - 27 }));
    expect(rest.text).toBe("The cap is EUR 4.2 million.");
    expect(rest.more).toBeUndefined();

    const run = parse(readHistory(items, { id: "m1", through: "m2" }));
    expect(run.messages.map((m: { id: string }) => m.id)).toEqual(["m1", "m2"]);

    expect(readHistory(items, { id: "m99" })).toMatchObject({ isError: true, content: expect.stringContaining('No message "m99"') });
  });
});
