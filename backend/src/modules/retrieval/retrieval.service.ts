// Business logic + data-access for the retrieval module.
//
// This module is service-only: it has no HTTP routes — callers are other
// backend surfaces (chat context assembly, tool calls) that already
// authorized the user. Everything lives in one topic file today
// (retrieval.search.ts: chunking, indexing, hybrid search); split it into
// siblings and re-export here if it grows.
//
// The service does not check document permissions: the backend connects as
// service_role and bypasses RLS, so the caller owns the access decision and
// passes the scope it resolved (documentIds or projectId). Chat wiring is
// deferred; see the wiring point in retrieval.search.ts for where indexing
// of extracted text belongs.

export { chunkText, indexVersionChunks, searchChunks } from "./retrieval.search";
export type {
    ChunkPageSource,
    ChunkSearchResult,
    IndexVersionChunksInput,
    SearchChunksInput,
    TextChunk,
} from "./retrieval.search";
