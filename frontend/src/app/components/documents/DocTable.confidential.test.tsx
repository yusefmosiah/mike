import { useState, type ComponentProps } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Document } from "@/app/components/shared/types";
import { updateDocumentConfidential } from "@/app/lib/mikeApi";
import { DocTable } from "./DocTable";

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    updateDocumentConfidential: vi.fn(),
}));

const allowAll = () => true;

function document(overrides: Partial<Document> = {}): Document {
    return {
        id: "doc-1",
        user_id: "user-1",
        project_id: null,
        confidential: false,
        folder_id: null,
        filename: "Lease.pdf",
        file_type: "pdf",
        storage_path: "doc-1.pdf",
        pdf_storage_path: null,
        size_bytes: 10,
        page_count: 1,
        structure_tree: null,
        status: "ready",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        ...overrides,
    };
}

type DocTableOperations = ComponentProps<typeof DocTable>["operations"];

function operations(): DocTableOperations {
    return {
        uploadDocument: vi.fn(),
        refreshCollection: vi.fn().mockResolvedValue(undefined),
        createFolder: vi.fn(),
        resolveFolderPath: vi.fn(),
        renameFolder: vi.fn(),
        deleteFolder: vi.fn(),
        moveFolder: vi.fn(),
        moveDocument: vi.fn(),
        renameDocument: vi.fn(),
    };
}

function Harness({ initialDocuments }: { initialDocuments: Document[] }) {
    const [documents, setDocuments] = useState(initialDocuments);
    const [folders, setFolders] = useState<
        ComponentProps<typeof DocTable>["folders"]
    >([]);
    return (
        <>
            <output data-testid="documents-state">
                {JSON.stringify(documents)}
            </output>
            <DocTable
                scopeKey="library-files"
                documents={documents}
                setDocuments={setDocuments}
                folders={folders}
                setFolders={setFolders}
                loading={false}
                search=""
                operations={operations()}
                emptyStateTitle="Documents"
                canDo={allowAll}
            />
        </>
    );
}

describe("DocTable confidential row action", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("patches a standalone document from the row menu and updates the row", async () => {
        const user = userEvent.setup();
        vi.mocked(updateDocumentConfidential).mockResolvedValue(
            document({ confidential: true }),
        );
        render(<Harness initialDocuments={[document()]} />);

        await user.click(
            screen.getByRole("button", { name: "Open row actions" }),
        );
        await user.click(
            screen.getByRole("button", { name: "Mark confidential" }),
        );

        await waitFor(() =>
            expect(updateDocumentConfidential).toHaveBeenCalledWith(
                "doc-1",
                true,
            ),
        );
        expect(await screen.findByText("Confidential")).toBeInTheDocument();
        expect(screen.getByTestId("documents-state")).toHaveTextContent(
            '"confidential":true',
        );

        await user.click(
            screen.getByRole("button", { name: "Open row actions" }),
        );
        expect(
            screen.getByRole("button", { name: "Share across chats" }),
        ).toBeInTheDocument();
    });

    it("does not offer the action for a project document", async () => {
        const user = userEvent.setup();
        render(
            <Harness
                initialDocuments={[
                    document({ project_id: "project-1" }),
                ]}
            />,
        );

        await user.click(
            screen.getByRole("button", { name: "Open row actions" }),
        );

        expect(
            screen.queryByRole("button", { name: "Mark confidential" }),
        ).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Share across chats" }),
        ).toBeNull();
    });
});
