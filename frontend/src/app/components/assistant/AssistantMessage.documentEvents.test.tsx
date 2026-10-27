import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/app/lib/authEvents";
import { AssistantMessage } from "./AssistantMessage";
import type { AssistantEvent } from "../shared/types";

vi.mock("@/app/lib/authEvents", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    API_BASE: "/api",
}));

describe("AssistantMessage document events", () => {
    it("opens every identified event document in the document panel", () => {
        const onOpenDocument = vi.fn();
        const events: AssistantEvent[] = [
            {
                type: "doc_read",
                filename: "read.docx",
                document_id: "document-read",
                version_id: "version-read",
                version_number: 2,
            },
            {
                type: "doc_find",
                filename: "searched.pdf",
                document_id: "document-find",
                version_id: "version-find",
                version_number: 5,
                query: "termination",
                total_matches: 2,
            },
            {
                type: "doc_created",
                filename: "created.docx",
                document_id: "document-created",
                version_id: "version-created",
                version_number: 3,
                download_url: "",
            },
            {
                type: "doc_replicated",
                filename: "template.docx",
                count: 2,
                copies: [
                    {
                        new_filename: "copy-one.docx",
                        document_id: "document-copy-one",
                        version_id: "version-copy-one",
                    },
                    {
                        new_filename: "copy-two.docx",
                        document_id: "document-copy-two",
                        version_id: "version-copy-two",
                    },
                ],
            },
            {
                type: "doc_edited",
                filename: "edited.docx",
                document_id: "document-edited",
                version_id: "version-edited",
                version_number: 4,
                download_url: "",
                annotations: [],
            },
        ];

        render(
            <AssistantMessage
                events={events}
                onOpenDocument={onOpenDocument}
            />,
        );

        const editedButton = screen.getByRole("button", {
            name: "edited.docx",
        });
        expect(
            editedButton.querySelector(
                'img[src*="/icons/file-types/word.svg"]',
            ),
        ).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "read.docx" }));
        fireEvent.click(
            screen.getByRole("button", { name: "searched.pdf" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "created.docx" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "copy-one.docx" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "copy-two.docx" }),
        );
        fireEvent.click(editedButton);

        expect(onOpenDocument.mock.calls).toEqual([
            [
                {
                    documentId: "document-read",
                    filename: "read.docx",
                    versionId: "version-read",
                    versionNumber: 2,
                },
            ],
            [
                {
                    documentId: "document-find",
                    filename: "searched.pdf",
                    versionId: "version-find",
                    versionNumber: 5,
                },
            ],
            [
                {
                    documentId: "document-created",
                    filename: "created.docx",
                    versionId: "version-created",
                    versionNumber: 3,
                },
            ],
            [
                {
                    documentId: "document-copy-one",
                    filename: "copy-one.docx",
                    versionId: "version-copy-one",
                    versionNumber: 1,
                },
            ],
            [
                {
                    documentId: "document-copy-two",
                    filename: "copy-two.docx",
                    versionId: "version-copy-two",
                    versionNumber: 1,
                },
            ],
            [
                {
                    documentId: "document-edited",
                    filename: "edited.docx",
                    versionId: "version-edited",
                    versionNumber: 4,
                },
            ],
        ]);
    });

    it("opens the edit wrapper as a plain document but keeps individual edit context", () => {
        const onOpenDocument = vi.fn();
        const onEditViewClick = vi.fn();
        const events: AssistantEvent[] = [
            {
                type: "doc_edited",
                filename: "agreement.docx",
                document_id: "document-1",
                version_id: "version-2",
                version_number: 2,
                download_url: "",
                annotations: [
                    {
                        edit_id: "edit-1",
                        document_id: "document-1",
                        version_id: "version-2",
                        version_number: 2,
                        change_id: "change-1",
                        deleted_text: "old one",
                        inserted_text: "new one",
                        status: "pending",
                    },
                    {
                        edit_id: "edit-2",
                        document_id: "document-1",
                        version_id: "version-2",
                        version_number: 2,
                        change_id: "change-2",
                        deleted_text: "old two",
                        inserted_text: "new two",
                        status: "pending",
                    },
                ],
            },
        ];

        render(
            <AssistantMessage
                events={events}
                onOpenDocument={onOpenDocument}
                onEditViewClick={onEditViewClick}
            />,
        );

        const viewButtons = screen.getAllByRole("button", { name: "View" });
        fireEvent.click(viewButtons[0]);
        expect(onOpenDocument).toHaveBeenCalledWith({
            documentId: "document-1",
            filename: "agreement.docx",
            versionId: "version-2",
            versionNumber: 2,
        });
        expect(onEditViewClick).not.toHaveBeenCalled();

        fireEvent.click(viewButtons[1]);
        expect(onEditViewClick).toHaveBeenCalledWith(
            expect.objectContaining({ edit_id: "edit-1" }),
            "agreement.docx",
            1,
        );
    });

    it("shows shown media once: no Created step or download card for the same document", async () => {
        vi.mocked(authenticatedFetch).mockImplementation(() =>
            Promise.resolve(new Response(new Blob(["x"]), { status: 200 })),
        );
        URL.createObjectURL = vi.fn(() => "blob:media");
        URL.revokeObjectURL = vi.fn();
        const onOpenDocument = vi.fn();
        const events: AssistantEvent[] = [
            {
                type: "doc_created",
                filename: "chart.png",
                document_id: "document-media",
                version_id: "version-media",
                version_number: 1,
                download_url: "/x",
            },
            {
                type: "media",
                document_id: "document-media",
                version_id: "version-media",
                version_number: 1,
                filename: "chart.png",
                kind: "image",
            },
            {
                type: "doc_created",
                filename: "other.docx",
                document_id: "document-other",
                version_id: "version-other",
                version_number: 1,
                download_url: "/x",
            },
        ];

        render(
            <AssistantMessage
                events={events}
                onOpenDocument={onOpenDocument}
            />,
        );

        // The media tile replaces the step and the download card for that
        // document; a different created document still gets its card.
        expect(
            screen.queryByRole("button", { name: "chart.png" }),
        ).toBeNull();
        expect(
            await screen.findByRole("button", {
                name: "Open chart.png in the document viewer",
            }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "other.docx" }),
        ).toBeInTheDocument();
    });
});
