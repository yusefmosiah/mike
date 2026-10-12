import { describe, expect, it, vi } from "vitest";
import type { FetchedPage } from "../../../lib/search/types";
import { attachWebSnapshots } from "./webSnapshots";

const page: FetchedPage = {
  url: "https://example.com/ruling",
  title: "Ruling",
  content: "The court held for the appellant.",
  contentSha256: "a".repeat(64),
  fetchedAt: "2026-10-12T09:00:00.000Z",
  source: "fetch",
  readerMarkdown: "# Ruling\n\nThe court held for the appellant.",
};

const web = (ref: number, url = page.url) => ({
  type: "citation_data",
  kind: "web",
  ref,
  url,
  quotes: [{ quote: "held for the appellant" }],
});

describe("attachWebSnapshots", () => {
  it("saves the page each web citation was checked against and records it on the citation", async () => {
    const store = vi.fn().mockResolvedValue("snap-1");
    const document = { kind: "document", ref: 3, doc_id: "doc-0" };

    const result = await attachWebSnapshots([web(1), document, web(2)], (url) => (url === page.url ? page : undefined), store);

    expect(store).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledWith({
      sourceKind: "web",
      url: page.url,
      content: page.content,
      readerMarkdown: page.readerMarkdown,
      retrievedAt: page.fetchedAt,
    });
    expect(result[0]).toMatchObject({ ref: 1, snapshot_id: "snap-1", retrieved_at: page.fetchedAt, snapshot_source: "fetch" });
    expect(result[1]).toBe(document);
    expect(result[2]).toMatchObject({ ref: 2, snapshot_id: "snap-1" });
  });

  it("marks a copy of a search result as such", async () => {
    const result = await attachWebSnapshots(
      [web(1)],
      () => ({ ...page, source: "search", readerMarkdown: undefined }),
      async () => "snap-2",
    );
    expect(result[0]).toMatchObject({ snapshot_id: "snap-2", snapshot_source: "search" });
  });

  it("leaves a citation as it was when its page was not read or cannot be saved", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const unread = web(1, "https://example.com/other");
    const unsaved = web(2);

    const result = await attachWebSnapshots(
      [unread, unsaved],
      (url) => (url === page.url ? page : undefined),
      async () => {
        throw new Error("insert failed: relation citation_snapshots");
      },
    );

    expect(result).toEqual([unread, unsaved]);
    expect(JSON.stringify(error.mock.calls)).not.toContain("citation_snapshots");
    error.mockRestore();
  });
});
