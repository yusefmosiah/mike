import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssistantSidePanel, type AssistantSidePanelTab } from "./AssistantSidePanel";

vi.mock("@/app/hooks/useDocumentViewers", () => ({
    useDocumentViewers: () => ({
        requestClose: vi.fn(),
        download: vi.fn(),
        registerDownload: vi.fn(),
        registerCloseGuard: vi.fn(),
        confirmation: null,
    }),
}));
vi.mock("@/app/hooks/useDocumentPermissions", () => ({
    useDocumentPermissions: () => () => ({ canEdit: true, canDelete: true }),
}));
vi.mock("./DocPanel", () => ({ DocPanel: () => <div>Document body</div> }));

const base = {
    activeTabId: null,
    onActivateTab: vi.fn(),
    onCloseTab: vi.fn(),
    onCloseAll: vi.fn(),
};

const tab: AssistantSidePanelTab = {
    kind: "document",
    id: "d1",
    document: {
        document_id: "d1",
        title: "nda.docx",
        type: "docx",
        metadata: [],
        quotes: [],
        version_id: null,
        version_number: null,
    },
};

describe("AssistantSidePanel initial view", () => {
    it("renders nothing when there is nothing to show", () => {
        const { container } = render(<AssistantSidePanel {...base} tabs={[]} />);
        expect(container).toBeEmptyDOMElement();
    });

    it("shows the picker straight away when there are no tabs", () => {
        render(<AssistantSidePanel {...base} tabs={[]} picker={<div>Picker</div>} />);
        expect(screen.getByText("Picker")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Open Documents" })).not.toBeInTheDocument();
    });

    it("shows a loading layout, not the picker, while documents open", () => {
        render(<AssistantSidePanel {...base} tabs={[]} picker={<div>Picker</div>} loading />);
        expect(screen.getByRole("status", { name: "Loading documents" })).toHaveAttribute("aria-busy", "true");
        expect(screen.queryByText("Picker")).not.toBeInTheDocument();
    });

    it("shows the active tab and neither picker nor loading when tabs exist", () => {
        render(
            <AssistantSidePanel
                {...base}
                tabs={[tab]}
                activeTabId="d1"
                picker={<div>Picker</div>}
                loading
                onOpenDocuments={vi.fn()}
            />,
        );
        expect(screen.getByText("Document body")).toBeInTheDocument();
        expect(screen.queryByText("Picker")).not.toBeInTheDocument();
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Open Documents" })).toBeInTheDocument();
    });

    it("shows an empty body when only the add button is offered", () => {
        render(<AssistantSidePanel {...base} tabs={[]} onOpenDocuments={vi.fn()} />);
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
});
