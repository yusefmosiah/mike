/**
 * Editing a sent prompt happens in the composer: its text and files load
 * there, both can change, and sending saves a new version of the prompt.
 * Whatever was being typed before comes back afterwards.
 */
import { createRef } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import type { Document, Message } from "@/app/components/shared/types";
import { ChatInput, type ChatInputHandle, type ChatInputProps } from "./ChatInput";

vi.mock("@/app/lib/mikeApi", () => ({ listWorkflows: vi.fn(async () => []) }));
vi.mock("@/app/contexts/UserProfileContext", () => ({ useUserProfile: vi.fn() }));
vi.mock("@/app/hooks/useConfiguredModels", () => ({ useConfiguredModels: () => [] }));
vi.mock("@/app/hooks/useModelVision", () => ({ useModelVision: () => ({}) }));
vi.mock("@/app/lib/modelAvailability", () => ({
    getModelProvider: vi.fn(),
    isModelAvailable: vi.fn(() => true),
}));
vi.mock("./ModelToggle", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./ModelToggle")>()),
    ModelToggle: () => null,
}));
vi.mock("./AddDocButton", () => ({ AddDocButton: () => null }));
vi.mock("./UploadOverlay", () => ({ UploadOverlay: () => null }));
vi.mock("../shared/FileTypeIcon", () => ({ FileTypeIcon: () => null }));
vi.mock("../modals/AddDocumentsModal", () => ({ AddDocumentsModal: () => null }));
vi.mock("./AssistantWorkflowModal", () => ({ AssistantWorkflowModal: () => null }));
vi.mock("../popups/ApiKeyMissingPopup", () => ({ ApiKeyMissingPopup: () => null }));

class ResizeObserverMock {
    observe() {}
    disconnect() {}
}

const sent: Message = {
    id: "m1",
    role: "user",
    content: "Compare these",
    files: [
        { filename: "old.png", document_id: "img-1", version_id: "v1", version_number: 1 },
        { filename: "lease.pdf", document_id: "doc-2" },
    ],
};
const replacement = { id: "img-2", filename: "new.png", file_type: "png", current_version_id: "v9" } as Document;

function renderComposer(props: Partial<ChatInputProps> = {}) {
    vi.mocked(useUserProfile).mockReturnValue({
        profile: {
            openRouterModels: [],
            vercelModels: [],
            openCodeGoModels: [],
            lastSelectedChatModel: "gpt-5.6-sol",
            lastSelectedReasoningLevel: "high",
            apiKeys: undefined,
        },
        loading: false,
        apiKeysDegraded: false,
        persistChatModelSelection: vi.fn(async () => true),
        persistChatReasoningSelection: vi.fn(async () => true),
    } as unknown as ReturnType<typeof useUserProfile>);
    const ref = createRef<ChatInputHandle>();
    const onSubmit = vi.fn();
    const base = { chatKey: "c1", chatModel: "gpt-5.6-sol", onSubmit, onCancel: vi.fn(), isLoading: false };
    const view = render(<ChatInput ref={ref} {...base} {...props} />);
    const rerender = (next: Partial<ChatInputProps>) =>
        view.rerender(<ChatInput ref={ref} {...base} {...next} />);
    return { ref, onSubmit, rerender };
}

const textbox = () => screen.getByRole("combobox");

describe("editing a sent prompt in the composer", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    });

    it("loads its text and files, lets both change, and saves them as the edit", async () => {
        const onEditSubmit = vi.fn(async () => undefined);
        const { ref, onSubmit, rerender } = renderComposer();
        // A draft in progress is set aside, not lost.
        fireEvent.change(textbox(), { target: { value: "half a thought" } });

        rerender({ editTarget: sent, onEditSubmit, onEditCancel: vi.fn() });
        expect(screen.getByText("Editing message")).toBeInTheDocument();
        expect(textbox()).toHaveValue("Compare these");
        expect(screen.getByText("old.png")).toBeInTheDocument();
        expect(screen.getByText("lease.pdf")).toBeInTheDocument();

        // Swap the image for another, and reword.
        fireEvent.click(screen.getByRole("button", { name: "Remove old.png" }));
        act(() => ref.current!.addDoc(replacement));
        fireEvent.change(textbox(), { target: { value: "Compare these, again" } });
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));

        expect(onSubmit).not.toHaveBeenCalled();
        expect(onEditSubmit).toHaveBeenCalledWith({
            content: "Compare these, again",
            files: [
                { filename: "lease.pdf", document_id: "doc-2" },
                { filename: "new.png", document_id: "img-2", version_id: "v9" },
            ],
        });

        // Saved: the host ends the edit, and the draft comes back.
        rerender({ editTarget: null });
        expect(screen.queryByText("Editing message")).toBeNull();
        expect(textbox()).toHaveValue("half a thought");
        expect(screen.queryByText("lease.pdf")).toBeNull();
    });

    it("keeps the files at the versions the prompt sent", () => {
        const onEditSubmit = vi.fn(async () => undefined);
        renderComposer({ editTarget: sent, onEditSubmit });
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));
        expect(onEditSubmit).toHaveBeenCalledWith({
            content: "Compare these",
            files: [
                { filename: "old.png", document_id: "img-1", version_id: "v1", version_number: 1 },
                { filename: "lease.pdf", document_id: "doc-2" },
            ],
        });
    });

    it("keeps the edit in place when saving it fails, to send again", async () => {
        const onEditSubmit = vi.fn(async () => {
            throw new Error("offline");
        });
        renderComposer({ editTarget: sent, onEditSubmit });
        fireEvent.change(textbox(), { target: { value: "Reworded" } });
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));
        await waitFor(() => expect(onEditSubmit).toHaveBeenCalledTimes(1));
        expect(textbox()).toHaveValue("Reworded");
        expect(screen.getByText("Editing message")).toBeInTheDocument();
        // A second send while the first is saving is ignored, then goes once it has failed.
        await waitFor(() => {
            fireEvent.click(screen.getByRole("button", { name: "Send message" }));
            expect(onEditSubmit).toHaveBeenCalledTimes(2);
        });
    });

    it("cancels with the close button or Escape, and ignores commands in an edit", () => {
        const onEditCancel = vi.fn();
        const onEditSubmit = vi.fn(async () => undefined);
        renderComposer({ editTarget: sent, onEditSubmit, onEditCancel });
        fireEvent.click(screen.getByRole("button", { name: "Cancel editing" }));
        fireEvent.keyDown(textbox(), { key: "Escape" });
        expect(onEditCancel).toHaveBeenCalledTimes(2);

        // `/nr` and the like are for new messages: an edit is saved as written.
        fireEvent.change(textbox(), { target: { value: "/nr just a note" } });
        fireEvent.keyDown(textbox(), { key: "Enter", metaKey: true });
        expect(onEditSubmit).toHaveBeenCalledWith(
            expect.objectContaining({ content: "/nr just a note" }),
        );
    });
});
