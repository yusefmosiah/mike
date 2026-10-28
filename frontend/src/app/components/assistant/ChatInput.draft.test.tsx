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

    it("clears the stored Home draft even when sending unmounts the initial composer in the same render", async () => {
        let unmountInitial = () => {};
        const onSubmit = vi.fn(() => {
            unmountInitial();
        });
        const initial = renderComposer({ chatKey: null, onSubmit });
        unmountInitial = initial.unmount;
        typeDraft("first message from Home");

        await act(async () => {
            fireEvent.keyDown(textbox(), { key: "Enter", metaKey: true });
        });
        expect(onSubmit).toHaveBeenCalledTimes(1);

        // Returning Home mounts the new-chat composer again; the sent prompt must not come back.
        renderComposer({ chatKey: null });
        expect(textbox()).toHaveValue("");
    });

    it("keeps the draft when sending is refused", async () => {
        vi.mocked(useUserProfile).mockReturnValue({
            profile: {
                openRouterModels: [],
                vercelModels: [],
                openCodeGoModels: [],
                lastSelectedChatModel: null,
                lastSelectedReasoningLevel: "high",
                apiKeys: undefined,
            },
            loading: false,
            apiKeysDegraded: false,
            persistChatModelSelection: vi.fn(async () => true),
            persistChatReasoningSelection: vi.fn(async () => true),
        } as unknown as ReturnType<typeof useUserProfile>);
        const view = renderComposer({ chatKey: null, chatModel: null });
        typeDraft("keep me until a model is picked");

        await act(async () => {
            fireEvent.keyDown(textbox(), { key: "Enter", metaKey: true });
        });
        expect(view.onSubmit).not.toHaveBeenCalled();
        expect(textbox()).toHaveValue("keep me until a model is picked");

        view.unmount();
        renderComposer({ chatKey: null, chatModel: null });
        expect(textbox()).toHaveValue("keep me until a model is picked");
    });

    it("carries a new-chat draft across when the chat gains its id", () => {
        const view = renderComposer({
            chatKey: "",
            projectId: "p1",
            resetKey: "new:0",
        });
        typeDraft("written before the id arrived");

        view.rerender({
            chatKey: "chat-9",
            projectId: "p1",
            resetKey: "chat-9:0",
        });
        expect(textbox()).toHaveValue("written before the id arrived");

        // And the new-chat slot is now clean for the next fresh conversation.
        view.unmount();
        renderComposer({ chatKey: "", projectId: "p1", resetKey: "new:1" });
        expect(textbox()).toHaveValue("");
    });
});
