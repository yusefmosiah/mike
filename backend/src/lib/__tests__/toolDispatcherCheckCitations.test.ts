import { beforeEach, describe, expect, it, vi } from "vitest";

// check_citations runs a document citation check inside the turn and hands
// the model the flagged citations to relay, with the caller's identity and
// the turn's model.
const { start, run, summarize } = vi.hoisted(() => ({
    start: vi.fn(),
    run: vi.fn(),
    summarize: vi.fn(),
}));

vi.mock("../../modules/citations/citations.service", () => ({
    startCitationCheck: start,
    runCitationCheck: run,
    summarizeCitationCheck: summarize,
}));

import { runToolCalls } from "../../modules/chat/engine/tools/toolDispatcher";
import type { DocStore } from "../../modules/chat/engine/types";

const DOC_STORE: DocStore = new Map([
    ["doc-0", { storage_path: "documents/memo.docx", file_type: "docx", filename: "memo.docx" }],
]);
const DOC_INDEX = { "doc-0": { document_id: "document-1", version_id: "version-3", filename: "memo.docx" } };

async function call(docId: string, write: (s: string) => void = () => undefined) {
    return runToolCalls(
        [{ id: "call-1", function: { name: "check_citations", arguments: JSON.stringify({ doc_id: docId }) } }],
        DOC_STORE,
        "user-1",
        {} as never,
        write,
        undefined,
        undefined,
        DOC_INDEX as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { userEmail: "user@example.com", model: "turn-model" },
    );
}

beforeEach(() => vi.clearAllMocks());

describe("check_citations", () => {
    it("checks the document's version as the caller and returns what was flagged", async () => {
        start.mockResolvedValue({ ok: true, data: { id: "task-1" } });
        run.mockImplementation(async (_db: unknown, _id: string, deps: { onChecked: (d: number, t: number) => void }) => {
            deps.onChecked(1, 2);
            return { outcome: "completed" };
        });
        summarize.mockResolvedValue({ task_id: "task-1", flagged: [{ verdict: "contradicted" }] });
        const written: string[] = [];

        const { toolResults } = await call("doc-0", (s) => written.push(s));

        expect(start).toHaveBeenCalledWith(
            {},
            expect.objectContaining({
                userId: "user-1",
                userEmail: "user@example.com",
                documentId: "document-1",
                versionId: "version-3",
                model: "turn-model",
                enqueue: false,
            }),
        );
        expect(written).toContain(": citation-check 1/2\n\n");
        expect(JSON.parse((toolResults[0] as { content: string }).content)).toEqual({
            task_id: "task-1",
            flagged: [{ verdict: "contradicted" }],
        });
    });

    it("reports a document that is not in the chat, and a check that cannot start", async () => {
        const missing = await call("doc-9");
        expect(JSON.parse((missing.toolResults[0] as { content: string }).content).error).toMatch(/not found/);
        expect(start).not.toHaveBeenCalled();

        start.mockResolvedValue({ ok: false, kind: "validation", detail: "Select a model first." });
        const refused = await call("doc-0");
        expect(JSON.parse((refused.toolResults[0] as { content: string }).content)).toEqual({ error: "Select a model first." });
        expect(run).not.toHaveBeenCalled();
    });
});
