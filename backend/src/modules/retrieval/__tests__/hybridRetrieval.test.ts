// Unit tests for the retrieval service: chunking (page markers, overlap, OCR
// provenance), delete-then-insert indexing, and RRF fusion of the trigram and
// literal search arms. The database is the shared strict query script
// (scriptedDb), so a changed query or a changed statement order fails here
// rather than in production.

import { describe, expect, it } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import {
    chunkText,
    indexVersionChunks,
    searchChunks,
} from "../retrieval.search";

const doc = "doc-1";
const version = "ver-1";

function chunkRow(index: number, overrides: Record<string, unknown> = {}) {
    const row = {
        id: `chunk-${index}`,
        document_id: doc,
        version_id: version,
        chunk_index: index,
        content: `content ${index}`,
        page_no: 1,
        page_source: "text",
        score: 0.5,
        ...overrides,
    };
    return row;
}

describe("chunkText", () => {
    it("cuts a page into 1000-character chunks with 100 characters of overlap", () => {
        const body = "alpha ".repeat(200); // 1200 characters
        const chunks = chunkText(`[Page 1]\n${body}`);
        expect(chunks.map((chunk) => chunk.content)).toEqual([
            body.slice(0, 1000),
            body.trim().slice(900),
        ]);
        expect(chunks[0].content.slice(-100)).toBe(
            chunks[1].content.slice(0, 100),
        );
        expect(chunks.map((chunk) => chunk.page_no)).toEqual([1, 1]);
        expect(chunks.every((chunk) => chunk.page_source === "text")).toBe(true);
    });

    it("records page numbers and flags OCR pages from the page markers", () => {
        const chunks = chunkText(
            "[Page 1]\nfirst page text\n\n[Page 2 — OCR]\nsecond page text",
        );
        expect(chunks).toEqual([
            { content: "first page text", page_no: 1, page_source: "text" },
            { content: "second page text", page_no: 2, page_source: "ocr" },
        ]);
    });

    it("treats a page label that mentions OCR as OCR provenance", () => {
        const chunks = chunkText(
            "[Page 3 — scanned image, OCR pending]\ntext",
        );
        expect(chunks.map((chunk) => chunk.page_source)).toEqual(["ocr"]);
    });

    it("keeps pdfText's form-field sub-section on its own page", () => {
        const chunks = chunkText(
            "[Page 4]\nbody text\n[Page 4 form fields]\nAccepted: Yes",
        );
        expect(chunks).toHaveLength(1);
        expect(chunks[0].page_no).toBe(4);
        expect(chunks[0].content).toContain("Accepted: Yes");
    });

    it("treats markerless text as one unpositioned segment", () => {
        expect(chunkText("plain text with no markers")).toEqual([
            {
                content: "plain text with no markers",
                page_no: null,
                page_source: "text",
            },
        ]);
    });

    it("indexes nothing for pages without text", () => {
        expect(chunkText("[Page 1]\n\n[Page 2]\n   \n")).toEqual([]);
    });
});

describe("indexVersionChunks", () => {
    it("replaces the version's chunks — delete first, then insert", async () => {
        const fake = scriptedDb([
            { table: "document_chunks", op: "delete", data: null },
            { table: "document_chunks", op: "insert", data: null },
        ]);
        const result = await indexVersionChunks(fake.db, {
            documentId: doc,
            versionId: version,
            text: "[Page 1]\ncontract text\n[Page 2 — OCR]\nscanned text",
        });
        expect(result).toEqual({ chunkCount: 2 });
        expect(fake.calls[0].filters).toEqual([["eq", "version_id", version]]);
        expect(fake.calls[1].payload).toEqual([
            {
                document_id: doc,
                version_id: version,
                chunk_index: 0,
                content: "contract text",
                page_no: 1,
                page_source: "text",
            },
            {
                document_id: doc,
                version_id: version,
                chunk_index: 1,
                content: "scanned text",
                page_no: 2,
                page_source: "ocr",
            },
        ]);
        fake.done();
    });

    it("clears stale chunks when a re-extraction produced no text", async () => {
        const fake = scriptedDb([
            { table: "document_chunks", op: "delete", data: null },
        ]);
        await expect(
            indexVersionChunks(fake.db, {
                documentId: doc,
                versionId: version,
                text: "   ",
            }),
        ).resolves.toEqual({ chunkCount: 0 });
        expect(fake.calls).toHaveLength(1);
        fake.done();
    });
});

describe("searchChunks", () => {
    it("fuses the two arms with reciprocal rank fusion (k=60)", async () => {
        const shared = "b".repeat(600);
        const fake = scriptedDb([
            {
                rpc: "search_document_chunks_trgm",
                data: [
                    chunkRow(0, { content: "a".repeat(600) }),
                    chunkRow(1, { content: shared }),
                ],
            },
            {
                rpc: "search_document_chunks_keyword",
                data: [
                    chunkRow(1, { content: shared }),
                    chunkRow(2, { content: "c".repeat(300), page_source: "ocr" }),
                ],
            },
        ]);
        const results = await searchChunks(fake.db, {
            query: "termination clause",
            documentIds: [doc],
        });
        // Chunk 1 is in both arms, so it outranks the single-arm chunks.
        expect(results.map((result) => result.chunk_index)).toEqual([1, 0, 2]);
        expect(results[0].score).toBeCloseTo(1 / 61 + 1 / 62);
        expect(results[1].score).toBeCloseTo(1 / 61);
        expect(results[2].score).toBeCloseTo(1 / 62);
        expect(results[0].excerpt).toHaveLength(500);
        expect(results[2].page_source).toBe("ocr");
        expect(results[1].page_source).toBe("text");
        const args = {
            p_query: "termination clause",
            p_document_ids: [doc],
            p_limit: 40,
        };
        expect(fake.calls[0].args).toEqual(args);
        expect(fake.calls[1].args).toEqual(args);
        fake.done();
    });

    it("returns at most `limit` fused rows while fetching deeper arms", async () => {
        const rows = [chunkRow(0), chunkRow(1), chunkRow(2)];
        const fake = scriptedDb([
            { rpc: "search_document_chunks_trgm", data: rows },
            { rpc: "search_document_chunks_keyword", data: rows },
        ]);
        const results = await searchChunks(fake.db, {
            query: "notice",
            documentIds: [doc],
            limit: 2,
        });
        expect(results.map((result) => result.chunk_index)).toEqual([0, 1]);
        expect(fake.calls[0].args).toMatchObject({ p_limit: 20 });
        fake.done();
    });

    it("deduplicates explicit ids and leaves unscoped searches unbounded", async () => {
        const scoped = scriptedDb([
            { rpc: "search_document_chunks_trgm", data: [] },
            { rpc: "search_document_chunks_keyword", data: [] },
        ]);
        await searchChunks(scoped.db, {
            query: "notice",
            documentIds: [doc, doc, "doc-2"],
        });
        expect(scoped.calls[0].args).toMatchObject({
            p_document_ids: [doc, "doc-2"],
        });
        scoped.done();

        const unscoped = scriptedDb([
            { rpc: "search_document_chunks_trgm", data: [] },
            { rpc: "search_document_chunks_keyword", data: [] },
        ]);
        await searchChunks(unscoped.db, { query: "notice" });
        expect(unscoped.calls[0].args).toMatchObject({ p_document_ids: null });
        unscoped.done();
    });

    it("resolves a project scope to that project's document ids", async () => {
        const fake = scriptedDb([
            { table: "documents", data: [{ id: doc }, { id: "doc-2" }] },
            { rpc: "search_document_chunks_trgm", data: [] },
            { rpc: "search_document_chunks_keyword", data: [] },
        ]);
        await expect(
            searchChunks(fake.db, { query: "notice", projectId: "project-1" }),
        ).resolves.toEqual([]);
        expect(fake.calls[0].filters).toEqual([
            ["eq", "project_id", "project-1"],
        ]);
        expect(fake.calls[1].args).toMatchObject({
            p_document_ids: [doc, "doc-2"],
        });
        fake.done();
    });

    it("skips the arms when the project has no documents", async () => {
        const fake = scriptedDb([{ table: "documents", data: [] }]);
        await expect(
            searchChunks(fake.db, { query: "notice", projectId: "project-1" }),
        ).resolves.toEqual([]);
        fake.done();
    });

    it("does not touch the database for an empty query", async () => {
        const fake = scriptedDb([]);
        await expect(
            searchChunks(fake.db, { query: "   ", documentIds: [doc] }),
        ).resolves.toEqual([]);
        fake.done();
    });

    it("propagates a search failure instead of returning a partial ranking", async () => {
        const error = new Error("database unavailable");
        const fake = scriptedDb([
            { rpc: "search_document_chunks_trgm", error },
            { rpc: "search_document_chunks_keyword", data: [] },
        ]);
        await expect(
            searchChunks(fake.db, { query: "notice", documentIds: [doc] }),
        ).rejects.toBe(error);
        fake.done();
    });
});
