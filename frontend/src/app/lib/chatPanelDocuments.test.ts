import { describe, expect, it } from "vitest";
import type { Message } from "@/app/components/shared/types";
import { chatPanelDocuments } from "./chatPanelDocuments";

const assistant = (events: Message["events"]): Message => ({
    role: "assistant",
    content: "",
    events,
});

describe("chatPanelDocuments", () => {
    it("lists created, edited, shown and copied documents, oldest first", () => {
        const documents = chatPanelDocuments([
            { role: "user", content: "draft it" },
            assistant([
                { type: "doc_read", filename: "read.docx" } as never,
                {
                    type: "doc_created",
                    filename: "nda.docx",
                    download_url: "/x",
                    document_id: "d1",
                    version_id: "v1",
                    version_number: 1,
                },
                {
                    type: "doc_replicated",
                    filename: "nda.docx",
                    count: 1,
                    copies: [{ new_filename: "nda copy.docx", document_id: "d2", version_id: "v9" }],
                },
                {
                    type: "media",
                    document_id: "d3",
                    version_id: "v3",
                    version_number: 4,
                    filename: "chart.png",
                    kind: "image",
                },
            ]),
        ]);

        expect(documents).toEqual([
            { documentId: "d1", filename: "nda.docx", versionId: "v1", versionNumber: 1 },
            { documentId: "d2", filename: "nda copy.docx", versionId: "v9", versionNumber: 1 },
            { documentId: "d3", filename: "chart.png", versionId: "v3", versionNumber: 4 },
        ]);
    });

    it("keeps a document once, at its latest edit", () => {
        const edited = (versionId: string, n: number) =>
            ({
                type: "doc_edited",
                filename: "nda.docx",
                document_id: "d1",
                version_id: versionId,
                version_number: n,
                download_url: "/x",
                annotations: [],
            }) satisfies Message["events"] extends infer E ? (E extends Array<infer T> ? T : never) : never;
        const documents = chatPanelDocuments([
            assistant([
                { type: "doc_created", filename: "nda.docx", download_url: "/x", document_id: "d1", version_id: "v1" },
                { type: "doc_created", filename: "memo.docx", download_url: "/x", document_id: "d2", version_id: "v1" },
            ]),
            assistant([edited("v2", 2)]),
        ]);

        expect(documents.map((entry) => entry.documentId)).toEqual(["d2", "d1"]);
        expect(documents[1]).toMatchObject({ versionId: "v2", versionNumber: 2 });
    });

    it("skips events still streaming, failed, or without a document", () => {
        const documents = chatPanelDocuments([
            assistant([
                { type: "doc_created", filename: "a.docx", download_url: "", document_id: "a", isStreaming: true },
                { type: "doc_created", filename: "b.docx", download_url: "" },
                { type: "doc_edited", filename: "c.docx", document_id: "c", version_id: "v", version_number: null, download_url: "", annotations: [], error: "failed" },
                { type: "doc_replicated", filename: "d.docx", count: 1, isStreaming: true } as never,
                { type: "doc_replicated", filename: "e.docx", count: 1, error: "failed" } as never,
                { type: "doc_replicated", filename: "f.docx", count: 0 } as never,
                { type: "media", filename: "orphan.png", kind: "image" } as never,
            ]),
            { role: "assistant", content: "no events" },
        ]);

        expect(documents).toEqual([]);
    });
});
