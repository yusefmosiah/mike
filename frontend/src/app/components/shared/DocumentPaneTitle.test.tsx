import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentPaneTitle } from "./DocumentPaneTitle";

const fetchDocumentText = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    fetchDocumentText,
}));

beforeEach(() => {
    vi.resetAllMocks();
    fetchDocumentText.mockResolvedValue({ text: "body", chars: 4, format: "text" });
});

afterEach(cleanup);

describe("DocumentPaneTitle", () => {
    it("renders the filename and version chip without a copy action for other types", () => {
        render(
            <DocumentPaneTitle
                filename="Agreement.docx"
                fileType="docx"
                versionNumber={3}
                documentId="d1"
                copyable={false}
            />,
        );
        expect(screen.getByText("Agreement.docx")).toBeInTheDocument();
        expect(screen.getByText("V3")).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Copy document text" }),
        ).toBeNull();
    });

    it("shows the copy button for a copyable stored document and passes the editor's rich copy through", () => {
        const onCopy = vi.fn().mockResolvedValue(undefined);
        render(
            <DocumentPaneTitle
                filename="Agreement.docx"
                fileType="docx"
                versionNumber={3}
                documentId="d1"
                versionId="v9"
                copyable
                onCopy={onCopy}
            />,
        );
        expect(
            screen.getByRole("button", { name: "Copy document text" }),
        ).toBeInTheDocument();
    });

    it("omits the copy button without a document id even when copyable", () => {
        render(
            <DocumentPaneTitle
                filename="Agreement.docx"
                fileType="docx"
                copyable
            />,
        );
        expect(
            screen.queryByRole("button", { name: "Copy document text" }),
        ).toBeNull();
    });
});
