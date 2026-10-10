import { describe, expect, it } from "vitest";

import type { PanelDocument } from "@/app/components/shared/types";
import type { DocumentVersion } from "./mikeApi";
import { panelDocumentAtVersion } from "./panelDocumentAtVersion";

const document = { id: "doc-1", title: "Lease.docx", type: "docx", version_id: "v2", version_number: 2 } as unknown as PanelDocument;

describe("panelDocumentAtVersion", () => {
    it("shows the version's own filename and type", () => {
        const version = { id: "v1", version_number: 1, filename: "Lease draft.pdf", file_type: "application/pdf" } as unknown as DocumentVersion;
        expect(panelDocumentAtVersion(document, version)).toMatchObject({
            title: "Lease draft.pdf", type: "pdf", version_id: "v1", version_number: 1,
        });
    });

    it("keeps the document's title when the version has no filename", () => {
        const version = { id: "v3", version_number: 3, filename: null, file_type: null } as unknown as DocumentVersion;
        expect(panelDocumentAtVersion(document, version)).toMatchObject({ title: "Lease.docx", type: "docx", version_id: "v3" });
    });
});
