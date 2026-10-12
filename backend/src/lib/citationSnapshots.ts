import { createHash } from "node:crypto";
import type { Db } from "./db";

/** The source text a citation was checked against, as it is stored. */
export type CitationSnapshotInput = {
    sourceKind: "document" | "web" | "case" | "connector";
    documentId?: string | null;
    versionId?: string | null;
    url?: string | null;
    content: string;
    /** Document snapshots: the character range of each block in `content`. */
    blockOffsets?: { id: string; start: number; end: number }[] | null;
    /** Web snapshots: the page's main content as Markdown, for the reader view. */
    readerMarkdown?: string | null;
    /** When the source was read; defaults to now. */
    retrievedAt?: string;
};

/**
 * Store a snapshot once per source and content hash and return its id. The
 * table is readable by the service role only: callers serve it through a
 * route that checks the reader may see the citation.
 */
export async function storeCitationSnapshot(db: Db, snapshot: CitationSnapshotInput): Promise<string> {
    const digest = createHash("sha256").update(snapshot.content).digest("hex");
    let query = db
        .from("citation_snapshots")
        .select("id")
        .eq("source_kind", snapshot.sourceKind)
        .eq("content_sha256", digest);
    query = snapshot.versionId ? query.eq("document_version_id", snapshot.versionId) : query.eq("url", snapshot.url ?? "");
    const { data: existing } = await query.limit(1);
    const found = (existing as Array<{ id: string }> | null)?.[0];
    if (found) return found.id;
    const { data, error } = await db
        .from("citation_snapshots")
        .insert({
            source_kind: snapshot.sourceKind,
            document_id: snapshot.documentId ?? null,
            document_version_id: snapshot.versionId ?? null,
            url: snapshot.url ?? null,
            content: snapshot.content,
            content_sha256: digest,
            block_offsets: snapshot.blockOffsets ?? null,
            reader_markdown: snapshot.readerMarkdown ?? null,
            retrieved_at: snapshot.retrievedAt ?? new Date().toISOString(),
        })
        .select("id")
        .single();
    if (error || !data) throw error ?? new Error("snapshot not stored");
    return data.id as string;
}
