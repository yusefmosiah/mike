import { describe, expect, it } from "vitest";
import {
    isExternalSourceType,
    isPanelDocument,
    panelDocumentFromCitation,
    webCitationOriginalUrl,
    webPageRef,
    type DocumentCitation,
    type WebCitation,
} from "./types";

describe("panelDocumentFromCitation", () => {
    it("preserves quote verification for legacy document citations", () => {
        const citation: DocumentCitation = {
            type: "citation_data",
            kind: "document",
            ref: 1,
            doc_id: "document-1",
            document_id: "document-1",
            filename: "agreement.docx",
            page: 3,
            quote: "Unmatched quote",
            quotes: [
                {
                    page: 3,
                    quote: "Unmatched quote",
                    verification: { verified: false },
                },
            ],
        };

        expect(panelDocumentFromCitation(citation).quotes[0]).toMatchObject({
            quote: "Unmatched quote",
            verification: { verified: false },
            target: { page: 3 },
        });
    });

    it("reconciles verified top-level quotes into an older normalized document", () => {
        const citation: DocumentCitation = {
            type: "citation_data",
            kind: "document",
            ref: 1,
            doc_id: "document-1",
            document_id: "document-1",
            filename: "agreement.docx",
            page: 3,
            quote: "Corrected source quote",
            quotes: [
                {
                    page: 3,
                    quote: "Corrected source quote",
                    verification: { verified: true },
                },
            ],
            document: {
                document_id: "document-1",
                title: "agreement.docx",
                type: "docx",
                metadata: [],
                quotes: [
                    {
                        quote: "Drifted model quote",
                        target: { page: 3 },
                    },
                ],
            },
        };

        expect(panelDocumentFromCitation(citation).quotes[0]).toMatchObject({
            quote: "Corrected source quote",
            verification: { verified: true },
            target: { page: 3 },
        });
    });
});

describe("web citations in the reader view", () => {
    const SNAPSHOT = "6f783e59-35c4-4ddc-896a-94aa4d05a768";
    const web: WebCitation = {
        type: "citation_data",
        kind: "web",
        ref: 2,
        url: "https://example.com/ruling",
        title: "Ruling on appeal",
        site: "example.com",
        quotes: [
            { quote: "not found anywhere", verification: { verified: false } },
            { quote: "The court held for the appellant", verification: { verified: true } },
        ],
        snapshot_id: SNAPSHOT,
        retrieved_at: "2026-10-12T09:00:00.000Z",
        snapshot_source: "fetch",
    };

    it("opens the saved page through the chat that cites it", () => {
        const document = panelDocumentFromCitation(web, true, { chatId: "chat-1" });
        expect(document).toMatchObject({
            document_id: `web:chat-1:${SNAPSHOT}`,
            title: "Ruling on appeal",
            type: "web",
            metadata: [
                { label: "Site", value: "example.com" },
                { label: "Saved", value: "2026-10-12T09:00:00.000Z", format: "date" },
            ],
            actions: [
                {
                    type: "link",
                    label: "Open original",
                    url: "https://example.com/ruling#:~:text=The%20court%20held%20for%20the%20appellant",
                },
            ],
        });
        expect(document.quotes.map((quote) => quote.quote)).toEqual([
            "not found anywhere",
            "The court held for the appellant",
        ]);
        expect(webPageRef(document.document_id)).toEqual({ chatId: "chat-1", snapshotId: SNAPSHOT });
        expect(isPanelDocument(document)).toBe(true);
    });

    it("says when the saved copy is a search result's text", () => {
        const document = panelDocumentFromCitation({ ...web, snapshot_source: "search" as const }, false, { chatId: "chat-1" });
        expect(document.metadata[1]).toMatchObject({ label: "Search result saved" });
        expect(document.quotes).toEqual([]);
    });

    it("has no saved page without a chat, or for a citation made before pages were saved", () => {
        const legacy: WebCitation = { ...web, snapshot_id: undefined, retrieved_at: undefined, site: "" };
        expect(panelDocumentFromCitation(web).document_id).toBe("web:https://example.com/ruling");
        const document = panelDocumentFromCitation(legacy, true, { chatId: "chat-1" });
        expect(document.document_id).toBe("web:https://example.com/ruling");
        expect(document.metadata).toEqual([]);
        expect(webPageRef(document.document_id)).toBeNull();
    });

    it("links to the original at the quote, by its first and last words when it is long", () => {
        const long = {
            ...web,
            url: "https://example.com/ruling#top",
            quotes: [{ quote: "one two three four five six seven eight nine ten-eleven" }],
        };
        expect(webCitationOriginalUrl(long)).toBe(
            "https://example.com/ruling#top:~:text=one%20two%20three%20four,seven%20eight%20nine%20ten%2Deleven",
        );
        expect(webCitationOriginalUrl({ ...web, quotes: [] })).toBe("https://example.com/ruling");
        expect(webCitationOriginalUrl({ ...web, url: "javascript:alert(1)" })).toBeNull();
        expect(panelDocumentFromCitation({ ...web, url: "javascript:alert(1)" }).actions).toEqual([]);
    });

    it("counts cases, legislation and web pages as sources that are not files", () => {
        expect(["case", "legislation", "web"].map(isExternalSourceType)).toEqual([true, true, true]);
        expect(["docx", "pdf", undefined].map(isExternalSourceType)).toEqual([false, false, false]);
    });
});
