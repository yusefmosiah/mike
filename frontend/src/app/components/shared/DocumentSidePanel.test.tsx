import { fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { expect, it, vi } from "vitest";
import type { Document } from "@/app/components/shared/types";
import type { DocumentVersion } from "@/app/lib/mikeApi";
import { DocumentSidePanel } from "./DocumentSidePanel";

// Stand in for a viewer whose context menu portals to document.body.
vi.mock("@/app/components/shared/views/DocxView", () => ({
    DocxView: () =>
        createPortal(<button type="button">Viewer menu item</button>, document.body),
}));

const doc: Document = {
    id: "doc-1",
    project_id: "project-1",
    confidential: false,
    filename: "agreement.docx",
    file_type: "docx",
    storage_path: "documents/agreement.docx",
    pdf_storage_path: null,
    size_bytes: 1024,
    page_count: null,
    structure_tree: null,
    status: "ready",
    created_at: "2026-09-27T00:00:00Z",
};

function renderPanel(
    onClose = vi.fn(),
    options: { readOnly?: boolean; versions?: DocumentVersion[]; onPublish?: () => void } = {},
) {
    render(
        <DocumentSidePanel
            doc={doc}
            readOnly={options.readOnly ?? true}
            versions={options.versions ?? []}
            versionsLoading={false}
            onClose={onClose}
            onLoadVersions={vi.fn()}
            onSelectVersion={vi.fn()}
            onDownloadDocument={vi.fn()}
            onDownloadVersion={vi.fn()}
            onRenameVersion={vi.fn()}
            onDeleteVersion={vi.fn()}
            onUploadNewVersion={vi.fn()}
            onReplaceVersion={vi.fn()}
            onDelete={vi.fn()}
            onPublish={options.onPublish}
        />,
    );
    return onClose;
}

it("stays open for portaled menus opened from the viewer, but closes on a real outside press", async () => {
    const onClose = renderPanel();
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Viewer menu item" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
});

it("titles the document view and lists the latest version first", () => {
    const version = (n: number, createdAt: string): DocumentVersion => ({
        id: `v${n}`,
        version_number: n,
        source: "upload",
        created_at: createdAt,
        filename: `agreement-v${n}.docx`,
    });
    renderPanel(vi.fn(), {
        readOnly: false,
        // Out of order on purpose: the list must not rely on the API's order.
        versions: [
            version(1, "2026-09-01T00:00:00Z"),
            version(3, "2026-09-02T00:00:00Z"),
            version(2, "2026-09-03T00:00:00Z"),
        ],
    });

    expect(
        screen.getByRole("heading", { name: "agreement-v3.docx" }),
    ).toBeInTheDocument();
    expect(
        screen
            .getAllByRole("button", { name: /^Download Version/ })
            .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
        "Download Version 3",
        "Download Version 2",
        "Download Version 1",
    ]);
});

it("offers Publish beside the other actions only when the file can be published", () => {
    const onPublish = vi.fn();
    renderPanel(vi.fn(), { readOnly: true, onPublish });
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(onPublish).toHaveBeenCalledOnce();
});

it("shows Publish in the editable footer too, and hides it without a handler", () => {
    const onPublish = vi.fn();
    renderPanel(vi.fn(), { readOnly: false, onPublish });
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
});

it("has no Publish button when publishing is unavailable", () => {
    renderPanel(vi.fn(), { readOnly: true });
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
});
