// Retrieval: chunking plus hybrid (trigram + literal) search over document
// text.
//
// WHY keyword-only: this deployment has no pgvector and no embedding
// pipeline, so relevance has to come from Postgres alone. Two cheap,
// index-backed arms are fused with Reciprocal Rank Fusion:
//
//   - word_similarity (GIN trigram index) catches wording that is close but
//     not identical — "termination of the agreement" against a "termination
//     clause" — and ranks the matches;
//   - ILIKE '%query%' catches exact substrings the similarity arm ranks
//     poorly on short or numeric queries ("50%", "Section 12.4(b)").
//
// RRF (k=60) fuses the two ranked lists without needing their scores to be
// comparable, and lets a chunk surfaced by both arms outrank one surfaced by
// either alone. Embeddings are a follow-up that needs infrastructure
// (pgvector); when they land they are a third ranked list into the same
// fusion — the return shape does not change.
//
// Provenance: every chunk records its page and whether that page's text came
// from extraction or OCR, so citation verification downstream can treat the
// two differently (and a page still waiting on OCR is visibly not extracted
// text).
//
// Trust boundary: this module has no HTTP surface. Callers are backend
// surfaces that have already authorized the user, and the service does NOT
// check document permissions — the backend connects as service_role and
// bypasses RLS, so scoping is the caller's job. Passing neither documentIds
// nor projectId searches the whole corpus and is for internal paths only.
//
// Wiring point (deliberately not done here): the document.precompute_text
// handler in the documents module (documents.textJobs.ts) is where extracted
// text becomes known for legacy Office conversions, and that is where a call
// to indexVersionChunks(db, { documentId, versionId, text }) belongs. Only
// legacy-Office versions have that precompute job today — PDF text is
// extracted on demand — so indexing every version also needs a hook on the
// PDF/read path; both hooks land with the chat wiring. Until then, indexing
// is an explicit caller step.

import type { Db } from "../../lib/supabase";

/** Target chunk size in characters. */
export const CHUNK_SIZE = 1000;
/** Characters of overlap between consecutive chunks of the same page. */
export const CHUNK_OVERLAP = 100;

/** Excerpt length returned to callers; the full chunk stays in the database. */
const EXCERPT_CHARS = 500;
/** RRF rank constant: a row at rank r contributes 1 / (RRF_K + r). */
const RRF_K = 60;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** Each arm is fetched deeper than the fused result so fusion has room. */
const ARM_OVERFETCH = 4;
const MIN_ARM_LIMIT = 20;
const MAX_ARM_LIMIT = 100;
/** Rows per insert request; large documents would otherwise exceed one body. */
const MAX_CHUNKS_PER_INSERT = 500;

export type ChunkPageSource = "text" | "ocr";

/** One indexable piece of a version's extracted text. */
export type TextChunk = {
    content: string;
    page_no: number | null;
    page_source: ChunkPageSource;
};

export type IndexVersionChunksInput = {
    documentId: string;
    versionId: string;
    /** Extracted text, with `[Page i]` / `[Page i — OCR]` markers. */
    text: string;
};

export type SearchChunksInput = {
    query: string;
    /** Explicit scope; wins over projectId when both are given. */
    documentIds?: string[];
    /** Convenience scope: resolved to the project's document ids. */
    projectId?: string;
    limit?: number;
};

export type ChunkSearchResult = {
    document_id: string;
    version_id: string;
    chunk_index: number;
    excerpt: string;
    page_no: number | null;
    page_source: ChunkPageSource;
    score: number;
};

/** One row of public.document_chunks as the search functions return it. */
type ChunkRow = {
    id: string;
    document_id: string;
    version_id: string;
    chunk_index: number;
    content: string;
    page_no: number | null;
    page_source: string;
    score: number | null;
};

const PAGE_MARKER_RE = /^\[Page (\d+)([^\]]*)\]\s*$/;

type TextSegment = {
    pageNo: number | null;
    source: ChunkPageSource;
    text: string;
};

/**
 * Split extracted text into per-page segments on the `[Page i]` / `[Page i —
 * OCR]` markers the extraction paths emit. `[Page i form fields]` is a
 * continuation of page i, not a new page. Text before the first marker — or
 * text with no markers at all, like a plain-text source — becomes one
 * unpositioned segment.
 */
function splitPages(text: string): TextSegment[] {
    const segments: TextSegment[] = [];
    let current: TextSegment = { pageNo: null, source: "text", text: "" };
    for (const line of text.split("\n")) {
        const marker = PAGE_MARKER_RE.exec(line);
        if (!marker) {
            current.text += `${line}\n`;
            continue;
        }
        // The label after the page number separates OCR output from
        // extracted text, e.g. `[Page 3 — OCR]`. Drop the separator and test
        // for the word, so a longer note ("scanned image, OCR pending") still
        // reads as OCR provenance.
        const label = (marker[2] ?? "").replace(/^[\s—–-]+/, "").trim();
        if (/^form fields\b/i.test(label)) {
            current.text += `${line}\n`;
            continue;
        }
        segments.push(current);
        current = {
            pageNo: Number(marker[1]),
            source: /\bocr\b/i.test(label) ? "ocr" : "text",
            text: "",
        };
    }
    segments.push(current);
    return segments;
}

/**
 * Cut extracted text into overlapping chunks. Chunks never cross a page
 * marker: a chunk's page_no is then exact, which is what citation checking
 * needs, and overlap stays within a page.
 */
export function chunkText(text: string): TextChunk[] {
    const chunks: TextChunk[] = [];
    const step = CHUNK_SIZE - CHUNK_OVERLAP;
    for (const segment of splitPages(text)) {
        const body = segment.text.trim();
        if (!body) continue; // empty or still-pending pages index nothing
        for (let start = 0; start < body.length; start += step) {
            const content = body.slice(start, start + CHUNK_SIZE).trim();
            if (content) {
                chunks.push({
                    content,
                    page_no: segment.pageNo,
                    page_source: segment.source,
                });
            }
            if (start + CHUNK_SIZE >= body.length) break;
        }
    }
    return chunks;
}

/**
 * Replace a version's indexed chunks with the chunks of `text`.
 *
 * Delete-then-insert: a version's chunk set is derived data, never edited, so
 * a re-index (job retry, extraction re-run) replaces it wholesale. A crash
 * between the two statements leaves the version un-indexed rather than stale
 * — the same at-least-once contract the extracted-text cache has — and the
 * unique key on (version_id, chunk_index) makes a re-index that races another
 * indexer fail loudly instead of silently doubling the rows.
 */
export async function indexVersionChunks(
    db: Db,
    input: IndexVersionChunksInput,
): Promise<{ chunkCount: number }> {
    const chunks = chunkText(input.text);
    const { error: deleteError } = await db
        .from("document_chunks")
        .delete()
        .eq("version_id", input.versionId);
    if (deleteError) throw deleteError;
    if (chunks.length === 0) return { chunkCount: 0 };

    const rows = chunks.map((chunk, chunkIndex) => ({
        document_id: input.documentId,
        version_id: input.versionId,
        chunk_index: chunkIndex,
        content: chunk.content,
        page_no: chunk.page_no,
        page_source: chunk.page_source,
    }));
    for (let start = 0; start < rows.length; start += MAX_CHUNKS_PER_INSERT) {
        const { error } = await db
            .from("document_chunks")
            .insert(rows.slice(start, start + MAX_CHUNKS_PER_INSERT));
        if (error) throw error;
    }
    return { chunkCount: rows.length };
}

/**
 * Rank the chunks that match `query`, fused across the trigram and literal
 * arms. Chunks of soft-deleted versions are excluded by the search functions
 * themselves (versions are soft-deleted, so nothing cascades on delete).
 */
export async function searchChunks(
    db: Db,
    input: SearchChunksInput,
): Promise<ChunkSearchResult[]> {
    const query = input.query.trim();
    if (!query) return [];
    const requested = input.limit ?? DEFAULT_LIMIT;
    const limit = Math.min(Math.max(requested, 1), MAX_LIMIT);
    const documentIds = await resolveDocumentIds(db, input);
    if (documentIds && documentIds.length === 0) return [];

    const args = {
        p_query: query,
        p_document_ids: documentIds,
        p_limit: Math.min(
            Math.max(limit * ARM_OVERFETCH, MIN_ARM_LIMIT),
            MAX_ARM_LIMIT,
        ),
    };
    const [trigram, keyword] = await Promise.all([
        db.rpc("search_document_chunks_trgm", args),
        db.rpc("search_document_chunks_keyword", args),
    ]);
    if (trigram.error) throw trigram.error;
    if (keyword.error) throw keyword.error;
    return fuseRanks(
        (trigram.data ?? []) as ChunkRow[],
        (keyword.data ?? []) as ChunkRow[],
    ).slice(0, limit);
}

/**
 * The optional scopes: explicit ids win, then a project's documents, then no
 * scope at all (null = the caller owns the access decision and asked for the
 * whole corpus).
 */
async function resolveDocumentIds(
    db: Db,
    input: SearchChunksInput,
): Promise<string[] | null> {
    if (input.documentIds?.length) return [...new Set(input.documentIds)];
    if (!input.projectId) return null;
    const { data, error } = await db
        .from("documents")
        .select("id")
        .eq("project_id", input.projectId);
    if (error) throw error;
    return (data ?? []).map((row) => row.id as string);
}

/**
 * Reciprocal Rank Fusion over the two arms. Ranks are the position each row
 * holds in its arm's (ordered) result, so the arms never need comparable
 * scores; a chunk both arms return accumulates both contributions.
 */
function fuseRanks(
    trigramRows: ChunkRow[],
    keywordRows: ChunkRow[],
): ChunkSearchResult[] {
    const fused = new Map<string, { row: ChunkRow; score: number }>();
    const accumulate = (rows: ChunkRow[]) => {
        rows.forEach((row, index) => {
            const key = `${row.document_id}:${row.version_id}:${row.chunk_index}`;
            const contribution = 1 / (RRF_K + index + 1);
            const entry = fused.get(key);
            if (entry) entry.score += contribution;
            else fused.set(key, { row, score: contribution });
        });
    };
    accumulate(trigramRows);
    accumulate(keywordRows);
    return [...fused.values()]
        .sort(
            (a, b) =>
                b.score - a.score ||
                a.row.document_id.localeCompare(b.row.document_id) ||
                a.row.version_id.localeCompare(b.row.version_id) ||
                a.row.chunk_index - b.row.chunk_index,
        )
        .map(({ row, score }) => ({
            document_id: row.document_id,
            version_id: row.version_id,
            chunk_index: row.chunk_index,
            excerpt: row.content.slice(0, EXCERPT_CHARS),
            page_no: row.page_no,
            page_source: row.page_source === "ocr" ? "ocr" : "text",
            score,
        }));
}
