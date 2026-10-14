import { afterEach, expect, it, vi } from "vitest";

const search = vi.hoisted(() => ({ fetchPage: vi.fn(), getWebSnapshot: vi.fn() }));
vi.mock("../../../../lib/search/index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/search/index")>()),
  fetchPage: search.fetchPage,
  getWebSnapshot: search.getWebSnapshot,
}));

import { runToolCalls } from "../tools/toolDispatcher";

// fetch_web_page returns a window of the page and says so, rather than
// cutting the text silently while the schema promises all of it.

afterEach(() => {
  search.fetchPage.mockReset();
  search.getWebSnapshot.mockReset();
});

const page = (content: string) => ({
  url: "https://example.com/a",
  title: "A page",
  content,
  contentSha256: "abc",
  fetchedAt: "2026-10-13T00:00:00Z",
  source: "fetch" as const,
});

const fetchPage = async (args: Record<string, unknown>) => {
  const result = await runToolCalls(
    [{ id: "c1", function: { name: "fetch_web_page", arguments: JSON.stringify(args) } }],
    new Map(),
    "u1",
    {} as never,
    vi.fn(),
  );
  return JSON.parse((result.toolResults[0] as { content: string }).content);
};

it("returns a short page whole, marked as not truncated", async () => {
  search.fetchPage.mockResolvedValue(page("Short text."));
  expect(await fetchPage({ url: "https://example.com/a" })).toEqual({
    url: "https://example.com/a",
    title: "A page",
    content: "Short text.",
    sha256: "abc",
    offset: 0,
    returned_chars: 11,
    total_chars: 11,
    truncated: false,
  });
});

it("marks a cut page with its total length and the offset to continue from", async () => {
  const text = "x".repeat(30_000);
  search.fetchPage.mockResolvedValue(page(text));
  const first = await fetchPage({ url: "https://example.com/a" });
  expect(first).toMatchObject({
    returned_chars: 12_000,
    total_chars: 30_000,
    truncated: true,
    next_offset: 12_000,
  });
  expect(first.note).toContain("of 30,000. Call fetch_web_page again with offset: 12000");

  // The next window reads the same snapshot instead of fetching again.
  search.getWebSnapshot.mockReturnValue(page(text));
  const rest = await fetchPage({ url: "https://example.com/a", offset: 12_000, max_chars: 100_000 });
  expect(search.fetchPage).toHaveBeenCalledTimes(1);
  expect(rest).toMatchObject({ offset: 12_000, returned_chars: 18_000, truncated: true });
  expect(rest.next_offset).toBeUndefined();
  expect(rest.note).toContain("the end of the page");
});

it("caps max_chars at the most one call may return", async () => {
  search.fetchPage.mockResolvedValue(page("y".repeat(60_000)));
  const result = await fetchPage({ url: "https://example.com/a", max_chars: 1_000_000 });
  expect(result).toMatchObject({ returned_chars: 40_000, next_offset: 40_000 });
});
