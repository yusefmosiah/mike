import { useRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import type * as MikeApiModule from "@/app/lib/mikeApi";
import type * as ModelToggleModule from "./ModelToggle";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import type { Message } from "../shared/types";
import { useVoiceChat } from "@/app/hooks/useVoiceChat";
import { ChatInput, type ChatInputHandle } from "./ChatInput";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof MikeApiModule>()),
    listWorkflows: vi.fn(async () => []),
    getDictationVocabulary: vi.fn(async () => ({ terms: [] })),
    recordSpokenAnswer: vi.fn(async () => undefined),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({ useUserProfile: vi.fn() }));
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
    UploadOverlay: ({ warning }: { warning?: string | null }) => (warning ? <div role="alert">{warning}</div> : null),
}));
vi.mock("../shared/FileTypeIcon", () => ({ FileTypeIcon: () => null }));
vi.mock("../modals/AddDocumentsModal", () => ({ AddDocumentsModal: vi.fn(() => null) }));
vi.mock("./AssistantWorkflowModal", () => ({ AssistantWorkflowModal: vi.fn(() => null) }));
vi.mock("../popups/ApiKeyMissingPopup", () => ({
    ApiKeyMissingPopup: ({ open }: { open: boolean }) => (open ? <div>Add an API key</div> : null),
}));

class ResizeObserverMock {
    observe() {}
    disconnect() {}
    unobserve() {}
}

const nativePromise = vi.fn();
let emitNative: (data: unknown) => void = () => undefined;
const addListener = vi.fn((_plugin: string, _event: string, callback: (data: unknown) => void) => {
    emitNative = callback;
    return { remove: vi.fn() };
});

function inApp(methods = ["voiceStatus"]) {
    vi.stubGlobal("Capacitor", {
        PluginHeaders: [{ name: "MikeSpeech", methods: methods.map((name) => ({ name })) }],
        nativePromise,
        addListener,
    });
}

const thread: Message[] = [{ id: "u0", role: "user", content: "Hello" }];

function renderInput(props: Partial<Parameters<typeof ChatInput>[0]> = {}) {
    const onSubmit = vi.fn();
    const view = render(
        <ChatInput
            chatKey="chat-1"
            chatModel="gpt-5.6-luna"
            chatReasoningLevel="high"
            onSubmit={onSubmit}
            onCancel={vi.fn()}
            isLoading={false}
            canSend
            voice={{ chatId: "chat-1", messages: thread }}
            {...props}
        />,
    );
    return { ...view, onSubmit };
}

describe("ChatInput voice mode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
        nativePromise.mockImplementation(async (_plugin: string, method: string) =>
            method === "voiceStatus" ? { available: true, missing: [], downloadBytes: 0 } : undefined,
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

    it("offers voice mode only in an app build with the voice engine, in a thread", () => {
        const { rerender } = renderInput();
        expect(screen.queryByRole("button", { name: "Start voice mode" })).toBeNull();
        inApp(["speak"]);
        rerender(<ChatInput onSubmit={vi.fn()} onCancel={vi.fn()} isLoading={false} canSend voice={{ chatId: "c", messages: [] }} />);
        expect(screen.queryByRole("button", { name: "Start voice mode" })).toBeNull();
    });

    it("hides the button without a thread, and disables it while an answer arrives", () => {
        inApp();
        const { unmount } = renderInput({ voice: undefined });
        expect(screen.queryByRole("button", { name: "Start voice mode" })).toBeNull();
        unmount();
        renderInput({ isLoading: true });
        expect(screen.getByRole("button", { name: "Start voice mode" })).toBeDisabled();
    });

    it("replaces the composer with the voice panel, sends what is said as a voice message, and ends", async () => {
        inApp();
        const { onSubmit } = renderInput();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Start voice mode" }));
        });
        await screen.findByText("Listening");
        expect(document.querySelector("[data-slot='chat-input-surface']")).toHaveAttribute("hidden");
        // Focus moves from the hidden Start button to End, and the change is announced.
        expect(screen.getByRole("button", { name: "End" })).toHaveFocus();
        expect(screen.getByText("Voice mode on")).toHaveAttribute("aria-live", "polite");

        act(() => emitNative({ type: "partial", text: "summarise the" }));
        expect(screen.getByText("summarise the")).toBeInTheDocument();
        act(() => emitNative({ type: "turn", turnId: "t1", text: "summarise the lease", audioMs: 1200 }));
        await waitFor(() =>
            expect(onSubmit).toHaveBeenCalledWith({
                role: "user",
                content: "summarise the lease",
                model: "gpt-5.6-luna",
                reasoning: "high",
                voice: true,
            }),
        );

        // Ending removes the focused End button: focus returns to the composer.
        act(() => screen.getByRole("button", { name: "End" }).click());
        expect(screen.queryByRole("region", { name: "Voice mode" })).toBeNull();
        expect(screen.getByRole("combobox")).toHaveFocus();
        expect(screen.getByText("Voice mode ended")).toBeInTheDocument();
        expect(document.querySelector("[data-slot='chat-input-surface']")).not.toHaveAttribute("hidden");
        expect(nativePromise).toHaveBeenCalledWith("MikeSpeech", "voiceStop", undefined);
    });

    it("refuses a turn without an available model, saying why, and ends voice mode", async () => {
        inApp();
        const { onSubmit } = renderInput();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Start voice mode" }));
        });
        await screen.findByText("Listening");
        // The key was removed after voice mode started.
        vi.mocked(isModelAvailable).mockReturnValue(false);
        act(() => emitNative({ type: "turn", turnId: "t1", text: "summarise the lease", audioMs: 1200 }));
        expect(await screen.findByText("Add an API key")).toBeInTheDocument();
        expect(onSubmit).not.toHaveBeenCalled();
        expect(await screen.findByRole("alert")).toHaveTextContent("Could not send what you said");
        vi.mocked(isModelAvailable).mockReturnValue(true);
    });

    it("refuses a turn when no model is chosen", async () => {
        inApp();
        const { onSubmit } = renderInput({ chatModel: null, chatKey: null, chatReasoningLevel: null });
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Start voice mode" }));
        });
        await screen.findByText("Listening");
        act(() => emitNative({ type: "turn", turnId: "t1", text: "summarise the lease", audioMs: 1200 }));
        expect(await screen.findByText("Select a model")).toBeInTheDocument();
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it("shows the setup step when the models are missing, and the engine's refusal as a warning", async () => {
        inApp();
        nativePromise.mockImplementation(async (_plugin: string, method: string) => {
            if (method === "voiceStatus") return { available: false, missing: ["eou"], downloadBytes: 300e6 };
            if (method === "voiceInstall") return { available: true };
            throw { code: "permission-denied" };
        });
        renderInput();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Start voice mode" }));
        });
        expect(screen.getByRole("region", { name: "Voice mode setup" })).toHaveTextContent("about 300 MB");
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Download" }));
        });
        expect(await screen.findByRole("alert")).toHaveTextContent("microphone is off");
        expect(screen.queryByRole("region", { name: /Voice mode/ })).toBeNull();
    });
});

/**
 * The assistant page in miniature: the voice session belongs to the page, the
 * new-chat composer gives way to the thread's once a message is sent, and the
 * chat's id arrives once the server has created it.
 */
function NewChatPage({ onSubmit }: { onSubmit: (message: Message) => void }) {
    const inputRef = useRef<ChatInputHandle>(null);
    const [chatId, setChatId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [loading, setLoading] = useState(false);
    const session = useVoiceChat({
        chatId,
        messages,
        isResponseLoading: loading,
        send: (text) => inputRef.current?.sendVoice(text) ?? false,
        cancelResponse: () => setLoading(false),
    });
    const submit = (message: Message) => {
        onSubmit(message);
        setMessages([message, { role: "assistant", content: "", events: [] }]);
        setLoading(true);
    };
    const shared = {
        ref: inputRef,
        chatModel: "gpt-5.6-luna",
        chatReasoningLevel: "high" as const,
        onSubmit: submit,
        onCancel: () => setLoading(false),
        canSend: true,
        voice: { session },
    };
    return (
        <>
            {messages.length === 0 ? (
                <ChatInput key="new-chat" {...shared} isLoading={false} />
            ) : (
                <ChatInput key="thread" {...shared} chatKey={chatId} isLoading={loading} />
            )}
            <button type="button" onClick={() => setChatId("chat-new")}>
                Chat created
            </button>
            <button
                type="button"
                onClick={() =>
                    setMessages((prev) => [
                        prev[0],
                        { id: "a1", role: "assistant", content: "", events: [{ type: "content", text: "Ninety days." }] },
                    ])
                }
            >
                Answer arrives
            </button>
            <button type="button" onClick={() => setLoading(false)}>
                Answer ends
            </button>
        </>
    );
}

describe("ChatInput voice mode owned by the page", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
        nativePromise.mockImplementation(async (_plugin: string, method: string) =>
            method === "voiceStatus" ? { available: true, missing: [], downloadBytes: 0 } : undefined,
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

    it("offers voice mode on the new-chat screen only where the app has the voice engine", () => {
        const { unmount } = render(<NewChatPage onSubmit={vi.fn()} />);
        expect(screen.queryByRole("button", { name: "Start voice mode" })).toBeNull();
        unmount();
        inApp();
        render(<NewChatPage onSubmit={vi.fn()} />);
        expect(screen.getByRole("button", { name: "Start voice mode" })).toBeEnabled();
    });

    it("sends the first spoken turn to create the chat, and carries on in it without a second tap", async () => {
        inApp();
        const onSubmit = vi.fn();
        render(<NewChatPage onSubmit={onSubmit} />);
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Start voice mode" }));
        });
        await screen.findByText("Listening");

        act(() => emitNative({ type: "turn", turnId: "t1", text: "what notice is owed", audioMs: 1200 }));
        await waitFor(() =>
            expect(onSubmit).toHaveBeenCalledWith({
                role: "user",
                content: "what notice is owed",
                model: "gpt-5.6-luna",
                reasoning: "high",
                voice: true,
            }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Chat created" }));
        // The thread's composer has replaced the new-chat one, the chat has
        // its id, and voice mode is still on, its End control focused.
        expect(screen.getByRole("region", { name: "Voice mode" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "End" })).toHaveFocus();
        expect(document.querySelectorAll("[data-slot='chat-input-surface']")).toHaveLength(1);
        expect(document.querySelector("[data-slot='chat-input-surface']")).toHaveAttribute("hidden");

        fireEvent.click(screen.getByRole("button", { name: "Answer arrives" }));
        fireEvent.click(screen.getByRole("button", { name: "Answer ends" }));
        expect(nativePromise).toHaveBeenCalledWith("MikeSpeech", "voiceSpeak", {
            turnId: "t1",
            clauseId: 0,
            text: "Ninety days.",
            final: true,
        });
        expect(nativePromise).not.toHaveBeenCalledWith("MikeSpeech", "voiceStop", undefined);
        expect(screen.getByRole("region", { name: "Voice mode" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Start voice mode" })).toBeNull();

        act(() => screen.getByRole("button", { name: "End" }).click());
        expect(screen.queryByRole("region", { name: "Voice mode" })).toBeNull();
        expect(screen.getByRole("combobox")).toHaveFocus();
        expect(nativePromise).toHaveBeenCalledWith("MikeSpeech", "voiceStop", undefined);
    });
});
