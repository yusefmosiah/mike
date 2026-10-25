import { afterEach, expect, it, vi } from "vitest";

const search = vi.hoisted(() => ({ search: vi.fn(), fetchPage: vi.fn(), getWebSnapshot: vi.fn() }));
vi.mock("../../../../lib/search/index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/search/index")>()),
  search: search.search,
  fetchPage: search.fetchPage,
  getWebSnapshot: search.getWebSnapshot,
}));

import { runToolCalls } from "../tools/toolDispatcher";

// Web searches and page reads are step sources: each is recorded and
// streamed as an event naming the call that made it.

afterEach(() => {
  search.search.mockReset();
  search.fetchPage.mockReset();
  search.getWebSnapshot.mockReset();
});

const run = async (calls: { id: string; name: string; args: Record<string, unknown> }[]) => {
  const frames: string[] = [];
  const result = await runToolCalls(
    calls.map((call) => ({ id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) } })),
    new Map(),
    "u1",
    {} as never,
    (chunk) => frames.push(chunk),
  );
  const streamed = frames
    .filter((frame) => frame.startsWith("data: {"))
    .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>);
  return { result, streamed };
};

it("records a search with its query and every result, under the call", async () => {
  search.search.mockResolvedValue([
    { title: "Lease law", url: "https://a.example/lease", snippet: "..." },
    { title: "", url: "https://b.example/", snippet: "..." },
  ]);
  const { result, streamed } = await run([{ id: "cell1.1", name: "web_search", args: { query: "break clause" } }]);
  const event = {
    type: "web_search",
    call_id: "cell1.1",
    query: "break clause",
    results: [{ url: "https://a.example/lease", title: "Lease law" }, { url: "https://b.example/" }],
  };
  expect(result.webEvents).toEqual([event]);
  expect(streamed).toContainEqual(event);
});

it("records a page read with its hash and the span read, and a failed read as an error", async () => {
  search.fetchPage.mockResolvedValueOnce({
    url: "https://a.example/lease",
    title: "Lease law",
    content: "Text of the page.",
    contentSha256: "f00d",
    fetchedAt: "2026-10-25T00:00:00Z",
    source: "fetch",
  });
  search.fetchPage.mockRejectedValueOnce(new Error("refused"));
  const { result } = await run([
    { id: "cell1.2", name: "fetch_web_page", args: { url: "https://a.example/lease" } },
    { id: "cell1.3", name: "fetch_web_page", args: { url: "https://down.example/" } },
  ]);
  expect(result.webEvents).toEqual([
    {
      type: "web_fetch",
      call_id: "cell1.2",
      url: "https://a.example/lease",
      title: "Lease law",
      sha256: "f00d",
      offset: 0,
      chars_read: 17,
      total_chars: 17,
    },
    { type: "web_fetch", call_id: "cell1.3", url: "https://down.example/", error: true },
  ]);
});

it("names the call on frames a tool streams, and nothing after the calls end", async () => {
  search.search.mockResolvedValue([]);
  const { streamed } = await run([{ id: "c7", name: "web_search", args: { query: "x" } }]);
  expect(streamed.every((event) => event.call_id === "c7")).toBe(true);
});
