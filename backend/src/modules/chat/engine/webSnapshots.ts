import type { CitationSnapshotInput } from "../../../lib/citationSnapshots";
import type { FetchedPage } from "../../../lib/search/types";
import { safeError } from "../../../lib/safeError";

/**
 * Save the page text each web citation was checked against, so the reader
 * view can show it after the in-memory copy is gone. The citation gains
 * `snapshot_id`, `retrieved_at` and `snapshot_source` ("fetch" for the page
 * itself, "search" for a search result's text). A citation whose page was
 * never read this turn, or whose copy cannot be saved, is left as it was:
 * the reader then shows its quotes and the link to the original.
 */
export async function attachWebSnapshots(
    citations: unknown[],
    lookup: (url: string) => FetchedPage | undefined,
    store: (snapshot: CitationSnapshotInput) => Promise<string>,
): Promise<unknown[]> {
    const stored = new Map<string, Promise<string | null>>();
    return Promise.all(
        citations.map(async (citation) => {
            if (!citation || typeof citation !== "object") return citation;
            const value = citation as Record<string, unknown>;
            if (value.kind !== "web" || typeof value.url !== "string") return citation;
            const page = lookup(value.url);
            if (!page?.content) return citation;
            let pending = stored.get(page.contentSha256 + page.url);
            if (!pending) {
                pending = store({
                    sourceKind: "web",
                    url: page.url,
                    content: page.content,
                    readerMarkdown: page.readerMarkdown ?? null,
                    retrievedAt: page.fetchedAt,
                }).catch((error: unknown) => {
                    console.error("[chat/citations] web snapshot not saved", safeError(error));
                    return null;
                });
                stored.set(page.contentSha256 + page.url, pending);
            }
            const snapshotId = await pending;
            if (!snapshotId) return citation;
            return {
                ...value,
                snapshot_id: snapshotId,
                retrieved_at: page.fetchedAt,
                snapshot_source: page.source ?? "fetch",
            };
        }),
    );
}
