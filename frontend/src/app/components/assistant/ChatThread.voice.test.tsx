import { createRef } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import type * as MikeApiModule from "@/app/lib/mikeApi";
import type * as ModelToggleModule from "./ModelToggle";
import type { Message } from "../shared/types";
import type { ChatInputHandle } from "./ChatInput";
import { ChatThread, type ChatThreadProps } from "./ChatThread";

// The real ChatInput and the real useVoiceChat run here: the regression under
// test is the session's survival when the composer remounts on the created
// chat's id, which a mocked composer could never observe.

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof MikeApiModule>()),
    listWorkflows: vi.fn(async () => []),
    getDictationVocabulary: vi.fn(async () => ({ terms: [] })),
    recordSpokenAnswer: vi.fn(async () => undefined),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({ useUserProfile: vi.fn() }));
vi.mock("@/app/contexts/AuthContext", () => ({ useOptionalAuth: () => null }));
vi.mock("@/app/hooks/useConfiguredModels", () => ({ useConfiguredModels: () => [] }));
vi.mock("@/app/lib/modelAvailability", () => ({
    getModelProvider: vi.fn(() => "openai"),
    isModelAvailable: vi.fn(() => true),
}));
vi.mock("./ModelToggle", async (importOriginal) => ({
    ...(await importOriginal<typeof ModelToggleModule>()),
    ModelToggle: () => null,
}));
vi.mock("./UploadOverlay", () => ({
    UploadOverlay: ({ warning }: { warning?: string | null }) =>
        warning ? <div role="alert">{warning}</div> : null,
}));
vi.mock("../shared/FileTypeIcon", () => ({ FileTypeIcon: () => null }));
vi.mock("../modals/AddDocumentsModal", () => ({ AddDocumentsModal: vi.fn(() => null) }));
vi.mock("./AssistantWorkflowModal", () => ({ AssistantWorkflowModal: vi.fn(() => null) }));
vi.mock("../popups/ApiKeyMissingPopup", () => ({
    ApiKeyMissingPopup: ({ open }: { open: boolean }) => (open ? <div>Add an API key</div> : null),
}));
vi.mock("./CodeApprovalRequests", () => ({ CodeApprovalRequests: () => null }));
vi.mock("./UserMessage", () => ({ UserMessage: () => null }));
vi.mock("./AssistantMessage", () => ({ AssistantMessage: () => null }));
vi.mock("./AgentReportMessage", () => ({ AgentReportMessage: () => null }));

class ResizeObserverMock {
    observe() {}
    disconnect() {}
    unobserve() {}
}

const nativePromise = vi.fn();
let emitNative: (data: unknown) => void = () => undefined;
const addListener = vi.fn(
    (_plugin: string, _event: string, callback: (data: unknown) => void) => {
        emitNative = callback;
        return { remove: vi.fn() };
    },
);

function inApp() {
    vi.stubGlobal("Capacitor", {
        PluginHeaders: [{ name: "MikeSpeech", methods: [{ name: "voiceStatus" }] }],
        nativePromise,
        addListener,
    });
}

function threadProps(overrides: Partial<ChatThreadProps>): ChatThreadProps {
    return {
        variant: "pane",
        chatId: null,
        messages: [],
        chatInputRef: createRef<ChatInputHandle>(),
        onSubmit: vi.fn(),
        onCancel: vi.fn(),
        chatModel: "gpt-5.6-luna",
        chatReasoningLevel: "high",
        onReplaceVoicePrompt: vi.fn(),
        onWorkflowClick: vi.fn(),
        activeCitation: null,
        onCitationClick: vi.fn(),
        onOpenCitationSource: vi.fn(),
        onCaseClick: vi.fn(),
        onEditViewClick: vi.fn(),
        onOpenDocument: vi.fn(),
        onEditResolveStart: vi.fn(),
        onEditResolved: vi.fn(),
        onEditError: vi.fn(),
        isDocReloading: () => false,
        isEditReloading: () => false,
        resolvedEditStatuses: {},
        ...overrides,
        isResponseLoading: overrides.isResponseLoading ?? false,
        viewerId: overrides.viewerId ?? "me",
        isHost: overrides.isHost ?? true,
    };
}

function renderPane(overrides: Partial<ChatThreadProps>) {
    return render(
        <div className="relative flex flex-col">
            <ChatThread {...threadProps(overrides)} />
        </div>,
    );
}

describe("ChatThread voice mode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
        Element.prototype.scrollTo = vi.fn();
        nativePromise.mockImplementation(async (_p: string, method: string) =>
            method === "voiceStatus"
                ? { available: true, missing: [], downloadBytes: 0 }
                : undefined,
        );
        vi.mocked(useUserProfile).mockReturnValue({
            profile: { openRouterModels: [], vercelModels: [], openCodeGoModels: [], apiKeys: {} },
            loading: false,
            apiKeysDegraded: false,
            persistChatModelSelection: vi.fn(),
            persistChatReasoningSelection: vi.fn(),
        } as never);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("offers hands-free voice in the project pane's new chat before the thread has an id", async () => {
        inApp();
        renderPane({ chatId: null, chatInputKey: "new:0" });
        expect(
            await screen.findByRole("button", { name: "Start voice mode" }),
        ).toBeEnabled();
    });

    it("keeps voice mode running when the first spoken turn creates the chat and remounts the composer", async () => {
        inApp();
        const onSubmit = vi.fn();
        const view = renderPane({ chatId: null, chatInputKey: "new:0", onSubmit });

        await act(async () => {
            fireEvent.click(
                await screen.findByRole("button", { name: "Start voice mode" }),
            );
        });
        await screen.findByText("Listening");

        const spoken: Message = {
            role: "user",
            content: "what notice is owed",
            voice: true,
        };
        act(() =>
            emitNative({
                type: "turn",
                turnId: "t1",
                text: "what notice is owed",
                audioMs: 1200,
            }),
        );
        await waitFor(() => expect(onSubmit).toHaveBeenCalled());

        // The chat got its id; the composer key changes and ChatInput remounts
        // — the voice session lives in the thread's gate, so nothing stops.
        view.rerender(
            <div className="relative flex flex-col">
                <ChatThread
                    {...threadProps({
                        chatId: "chat-9",
                        chatInputKey: "chat-9:0",
                        messages: [
                            spoken,
                            { role: "assistant", content: "", events: [] },
                        ],
                        isResponseLoading: true,
                        onSubmit,
                    })}
                />
            </div>,
        );

        expect(nativePromise).not.toHaveBeenCalledWith(
            "MikeSpeech",
            "voiceStop",
            undefined,
        );
        expect(
            screen.getByRole("region", { name: "Voice mode" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Start voice mode" }),
        ).toBeNull();
    });
});
