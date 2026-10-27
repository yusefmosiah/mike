/**
 * A composer draft belongs to the chat, not the mount: switching threads and
 * coming back, or reopening the app after a force-close, restores it. Sending
 * the message is what clears it.
 */
import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
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

function renderComposer(props: Partial<ChatInputProps> = {}) {
    const ref = createRef<ChatInputHandle>();
    const onSubmit = vi.fn();
    const base = {
        chatKey: "c1",
        chatModel: "gpt-5.6-sol",
        onSubmit,
        onCancel: vi.fn(),
        isLoading: false,
        canSend: true,
    };
    const view = render(<ChatInput ref={ref} {...base} {...props} />);
    const rerender = (next: Partial<ChatInputProps>) =>
        view.rerender(<ChatInput ref={ref} {...base} {...next} />);
    return { ref, onSubmit, rerender, unmount: view.unmount };
}

const textbox = () => screen.getByRole("combobox");

function typeDraft(text: string) {
    fireEvent.change(textbox(), { target: { value: text } });
}

describe("composer drafts", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
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
    });

    it("restores a draft typed in another mount of the same chat", () => {
        const first = renderComposer({ chatKey: "chat-1" });
        typeDraft("half-typed");
        first.unmount();

        renderComposer({ chatKey: "chat-1" });
        expect(textbox()).toHaveValue("half-typed");
    });

    it("keeps each chat's draft when the composer key switches threads", () => {
        const view = renderComposer({ chatKey: "chat-1" });
        typeDraft("for chat one");
        view.rerender({ chatKey: "chat-2" });
        expect(textbox()).toHaveValue("");

        typeDraft("for chat two");
        view.rerender({ chatKey: "chat-1" });
        expect(textbox()).toHaveValue("for chat one");
        view.rerender({ chatKey: "chat-2" });
        expect(textbox()).toHaveValue("for chat two");
    });

    it("the new-chat composer shares one draft across remounts", () => {
        const first = renderComposer({ chatKey: null });
        typeDraft("unsent new chat");
        first.unmount();

        renderComposer({ chatKey: null });
        expect(textbox()).toHaveValue("unsent new chat");
    });

    it("sending clears the draft so it does not come back", async () => {
        const view = renderComposer({ chatKey: "chat-1" });
        typeDraft("send me");
        await act(async () => {
            fireEvent.keyDown(textbox(), { key: "Enter", metaKey: true });
        });
        expect(view.onSubmit).toHaveBeenCalled();
        expect(textbox()).toHaveValue("");

        view.unmount();
        renderComposer({ chatKey: "chat-1" });
        expect(textbox()).toHaveValue("");
    });
});
